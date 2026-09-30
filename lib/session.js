// Conversation windows in the group: the "person has finished talking" debounce (R1, R11).
//
// Couple states (R6, R25, DR19); transitions are atomic in SQL, couple_transition:
//
//               activate (/start + admin + 2 consents)
//   onboarding ─────────────────────────────▶ active ◀── resume (paused_by only)
//                                               │  ▲
//                                         pause │  │
//                                               ▼  │
//                                             paused
//   active/paused/suspended ─ revoke ─▶ revoked ─ consent (both) ─▶ paused if paused_by, else active
//   active/paused ─ suspend ─▶ suspended ─ restore ─▶ paused if paused_by, else active
//   active ─ crisis in the group ─▶ active
//
// Leaving active and a crisis close the window and cancel /check; any change
// bumps state_version, so a generation already in progress isn't published (R12).
//
// Every partner message schedules a delayed check after DEBOUNCE_MS.
// The first unanswered message of a block also schedules a check after
// MAX_WAIT_MS, so in a fast argument the bot doesn't vanish (design doc, "Debounce").
//
//   message ─▶ schedule(debounce, 20 s) ─┐
//          └▶ first unanswered? ─ yes ─▶ schedule(max_wait, 60 s)
//                                        ▼
//   runCheck ─▶ decide(state, check)
//                ├ answered   — the block is already covered by a reply, nothing to do
//                ├ superseded — there's a newer message: its own check will reply
//                └ respond    — respond(window, marker) → lease in the database
//
// Where to wait: a delayed Vercel Queues message (delaySeconds). If the monthly
// Queues budget is ≥ 90% or send failed, sleep inside waitUntil (R1 fallback).
// Locally (bot.js) there's no queue: the same sleep, which is the setTimeout emulation.
//
// The helper's reply is respond below; runCheck receives it as a dependency so the
// debounce can be tested on its own. The R11 tail comes back from finish_reply and
// is scheduled through scheduleTail.

import * as db from "./db.js";
import { QUEUE_CUTOFF_PCT, QUEUE_MONTHLY_OPS, QUEUE_OPS_PER_MESSAGE } from "./ingest.js";
import { ContextRefused, buildGroupContext, recapAndFold } from "./context.js";
import { PAUSE_SCHEMA, PAUSE_SYSTEM, normalizePause, pausePrompt } from "./counsel.js";
import { deadlineIn, generate } from "./gemini.js";
import { bilingual, notification, pauseMessages, toSendArgs } from "./format.js";
import { call, deliver } from "./telegram.js";
import { text as copyText } from "./copy.js";
import { handleSignal } from "./safety.js";

export const DEBOUNCE_TOPIC = "debounce";
export const DEBOUNCE_MS = Number(process.env.DEBOUNCE_MS ?? 20_000);
export const MAX_WAIT_MS = Number(process.env.MAX_WAIT_MS ?? 60_000);
// Maximum wait for a voice transcription (R22, R26).
export const TRANSCRIPT_DEADLINE_MS = 120_000;

/**
 * A pure decision for a fired check.
 * @param {{answeredUpTo: number, latestId: number|null, ended?: boolean, checkActive?: boolean, pendingTranscripts?: number}} state
 * @param {{kind: "debounce"|"max_wait"|"transcript_deadline", messageId: number}} check
 * @returns {"answered"|"superseded"|"respond"|"check_active"|"waiting_transcript"}
 */
export function decide(state, check) {
  if (!state || state.ended || state.latestId === null) return "answered";
  // While a /check is running, the helper doesn't reply on debounce (design doc "/check").
  if (state.checkActive) return "check_active";
  // The helper's reply waits for the block's voice transcriptions (R22). It's woken by
  // the end of a transcription or by the check at the wait ceiling.
  if (state.pendingTranscripts > 0) return "waiting_transcript";

  if (check.kind === "max_wait") {
    // The block started by this message is already covered; later checks reply.
    return state.answeredUpTo >= check.messageId ? "answered" : "respond";
  }
  if (check.kind === "transcript_deadline") {
    // Wait ceiling: by now any stuck transcriptions are already failed.
    return state.answeredUpTo >= state.latestId ? "answered" : "respond";
  }

  if (state.answeredUpTo >= state.latestId) return "answered";
  // A newer message arrived: it has its own check, which will reply after the pause.
  if (state.latestId > check.messageId) return "superseded";
  return "respond";
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Schedules one check. Returns "queue" or "sleep", whichever path it took.
 * @param {{windowId: number, messageId: number, kind: string}} check
 * @param {number} delayMs
 * @param {object} deps
 * @param {Function} [deps.enqueue] send to Vercel Queues; absent means sleep right away
 * @param {(promise: Promise<unknown>) => void} deps.defer waitUntil / background
 * @param {(check: object) => Promise<unknown>} deps.run runs the check
 */
export async function schedule(check, delayMs, { enqueue, defer, run, store = db }) {
  if (enqueue) {
    let budgetOk = false;
    try {
      budgetOk = await store.queueBudgetTake(QUEUE_OPS_PER_MESSAGE, QUEUE_MONTHLY_OPS, QUEUE_CUTOFF_PCT);
    } catch (error) {
      console.warn(`[session] бюджет очереди не проверен: ${error.name}`);
      budgetOk = true;
    }
    if (budgetOk) {
      try {
        await enqueue(check, {
          delaySeconds: Math.ceil(delayMs / 1000),
          // Reprocessing the same message doesn't schedule a second check.
          idempotencyKey: `${check.kind}-${check.windowId}-${check.messageId}`,
        });
        return "queue";
      } catch (error) {
        console.warn(`[session] очередь недоступна (${error.name}), сон в фоне`);
      }
    } else {
      console.warn("[session] бюджет Queues ≥ 90%, сон в фоне");
    }
  }

  defer(
    sleep(delayMs)
      .then(() => run(check))
      .catch((error) => console.error(`[session] проверка ${check.kind} упала: ${error.name}: ${error.message}`)),
  );
  return "sleep";
}

/**
 * A partner's group message was stored: schedule the checks.
 * @param {{windowId: number, messageId: number}} message
 */
export async function onPartnerMessage({ windowId, messageId }, deps) {
  const store = deps.store ?? db;
  await schedule({ windowId, messageId, kind: "debounce" }, DEBOUNCE_MS, deps);

  const state = await store.debounceState(windowId);
  if (state?.firstUnansweredId === messageId) {
    await schedule({ windowId, messageId, kind: "max_wait" }, MAX_WAIT_MS, deps);
  }
}

/**
 * A voice message or video note in the group: the usual checks plus one at the
 * transcription wait ceiling (R26), which fires even if no new messages arrive.
 */
export async function onVoiceMessage({ windowId, messageId }, deps) {
  await onPartnerMessage({ windowId, messageId }, deps);
  await schedule({ windowId, messageId, kind: "transcript_deadline" }, TRANSCRIPT_DEADLINE_MS + 1_000, deps);
}

/**
 * The transcription is ready. The status changes exactly once (R26):
 *   on time — a debounce check on the latest message, but not before the pause;
 *   late (already failed) — the text is stored as late, the helper isn't woken.
 * Publishing the transcript (DR25) is the caller's job; late doesn't cancel it.
 * @returns {Promise<{applied: boolean, late: boolean}>}
 */
export async function onTranscript({ windowId, messageId, text, lang }, deps) {
  const store = deps.store ?? db;
  const result = await store.setTranscript(messageId, text, lang);
  if (!result.applied) return result;

  const state = await store.debounceState(windowId);
  if (state?.latestId !== null && state?.latestId !== undefined) {
    const now = deps.now?.() ?? Date.now();
    const sinceLatest = state.latestAt === null ? DEBOUNCE_MS : now - state.latestAt;
    await schedule({ windowId, messageId: state.latestId, kind: "debounce" }, Math.max(0, DEBOUNCE_MS - sinceLatest), deps);
  }
  return result;
}

// The R11 tail: finish_reply reported a message that arrived during generation.
export async function scheduleTail(windowId, messageId, deps) {
  return schedule({ windowId, messageId, kind: "debounce" }, DEBOUNCE_MS, deps);
}

// --- The helper's reply after a pause (R2, R12, R13, R20, R29, R30, R31, DR23) ---
//
//   lease ─ none ─▶ exit (window taken or marker moved)
//     │
//     ▼
//   target = the latest new message; key pause:<window>:<target>:<part>
//     │ part 0 already sent by a task that died ─▶ finish_reply only
//     ▼
//   context (couple not active ─▶ finish without a reply)
//     ▼
//   one model call (budget = lease − 15 s)
//     ├ ok ─ safety crisis/abuse ─▶ onSafety, the normal reply isn't published
//     │    └ parts: reply (speak) + translations (R29)
//     ├ blocked crisis ─▶ onSafety;  blocked neutral ─▶ neutral fallback
//     ├ quota ─▶ announcement once a day (key quota90:<couple>:<day>) + 👀
//     └ error ─▶ fallback "try retelling each other" + "Urgent help: /help" (DR14)
//     ▼
//   before each part can_publish (R12); parts go through the outbox (R13)
//     ▼
//   finish_reply(target) ─ tail ─▶ scheduleTail (R11)

export const LEASE_SECONDS = 90;
const GENERATION_BUDGET_MS = (LEASE_SECONDS - 15) * 1000;
const WAITING_REACTION = "👀";

const baseLang = (lang) => String(lang ?? "en").split(/[-_]/)[0].toLowerCase();

// The couple's languages: the addressee first (DR1), then member order, no repeats.
export function coupleLangs(members, addresseeUserId = null) {
  const ordered = [...members].sort((a, b) =>
    a.userId === addresseeUserId ? -1 : b.userId === addresseeUserId ? 1 : 0,
  );
  return [...new Set(ordered.map((m) => baseLang(m.lang)))];
}

// The next midnight Pacific time, when the Gemini quota resets.
export function nextQuotaReset(now = Date.now()) {
  const pacific = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
  }).formatToParts(new Date(now));
  const get = (type) => Number(pacific.find((p) => p.type === type).value);
  const msIntoDay = ((get("hour") * 60 + get("minute")) * 60 + get("second")) * 1000;
  return now - msIntoDay + 24 * 3600 * 1000;
}

export function pacificDay(now = Date.now()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(now));
}

async function groupText(context, key, params, textFn, paramsByLang = () => ({})) {
  const langs = coupleLangs(context.members);
  const [primary, secondary] = await Promise.all(
    langs.slice(0, 2).map(async (lang) => ({ lang, text: await textFn(lang, key, { ...params, ...paramsByLang(lang) }) })),
  );
  return bilingual({ primary, secondary });
}

function replyHtml(pause, context) {
  const addressee = context.members.find((m) => m.userId === Number(pause.addresseeUserId));
  const langs = coupleLangs(context.members, addressee?.userId ?? null);
  const byLang = new Map(pause.reply.map((r) => [baseLang(r.lang), r.text]));
  const ordered = langs.filter((l) => byLang.has(l)).map((lang) => ({ lang, text: byLang.get(lang) }));
  return bilingual({ primary: ordered[0], secondary: ordered[1], heading: addressee?.name ? `→ ${addressee.name}` : undefined });
}

/**
 * @param {number} windowId
 * @param {number} expectedMarker the marker read when deciding
 * @param {object} [deps] dependencies for tests and wiring
 */
export async function respond(windowId, expectedMarker, deps = {}) {
  const store = deps.store ?? db;
  const lease = await store.claimReplyWindow(windowId, expectedMarker, LEASE_SECONDS);
  if (!lease) return { claimed: false };

  const finish = async (marker) => {
    const r = await store.finishReply(windowId, lease, marker);
    if (r.ok && r.newerMessageId && deps.scheduleTail) await deps.scheduleTail(windowId, r.newerMessageId);
    return r;
  };

  const coupleId = await store.windowCouple(windowId);
  let context;
  try {
    context = await (deps.buildContext ?? buildGroupContext)(coupleId);
  } catch (error) {
    if (!(error instanceof ContextRefused)) throw error;
    await finish(expectedMarker);
    return { claimed: true, outcome: "refused" };
  }

  const fresh = context.shared.filter((m) => Number(m.id) > expectedMarker && !m.is_bot);
  if (fresh.length === 0) {
    await finish(expectedMarker);
    return { claimed: true, outcome: "nothing" };
  }
  const target = Math.max(...fresh.map((m) => Number(m.id)));
  const keyBase = `pause:${windowId}:${target}`;

  // A task that died after sending: the reply is already in the group, just finish (R13).
  if (await store.outboundStatus(`${keyBase}:0`)) {
    await finish(target);
    return { claimed: true, outcome: "already_published" };
  }

  const textFn = deps.text ?? copyText;
  const result = await (deps.generate ?? generate)({
    purpose: "pause",
    system: PAUSE_SYSTEM,
    parts: [{ text: pausePrompt(context, expectedMarker) }],
    schema: PAUSE_SCHEMA,
    deadline: deadlineIn(GENERATION_BUDGET_MS),
  });

  let parts;
  let key = keyBase;
  let outcome;
  let helperText = null;

  if (result.ok) {
    const pause = normalizePause(result.data, {
      newMessageIds: fresh.map((m) => Number(m.id)),
      voiceMessageIds: fresh.filter((m) => m.kind !== "text").map((m) => Number(m.id)),
      coupleLangs: coupleLangs(context.members),
      addressedToBot: fresh.some((m) => m.addresses_bot),
    });
    if (pause.safety === "crisis" || pause.safety === "abuse") {
      await (deps.onSafety ?? handleSignal)({ context, windowId, signal: pause.safety, surface: "group" });
      await finish(target);
      return { claimed: true, outcome: pause.safety };
    }
    let html = pause.speak ? replyHtml(pause, context) : null;
    if (html) helperText = pause.reply[0]?.text ?? null;
    if (!html && pause.speakRequested) html = await groupText(context, "fallback.neutral_block", {}, textFn);
    parts = pauseMessages({ chatId: context.groupChatId, replyHtml: html, translations: pause.translations });
    outcome = pause.speak ? "spoke" : "silent";
    await quotaNotices({ context, coupleId, usage: result.usage, store, textFn, deps });
    context.escalation = pause.escalation;
  } else if (result.blocked === "crisis") {
    await (deps.onSafety ?? handleSignal)({ context, windowId, signal: "crisis", surface: "group" });
    await finish(target);
    return { claimed: true, outcome: "crisis" };
  } else if (result.blocked === "neutral") {
    parts = pauseMessages({ chatId: context.groupChatId, replyHtml: await groupText(context, "fallback.neutral_block", {}, textFn) });
    outcome = "neutral_block";
  } else if (result.unavailable === "quota") {
    // One announcement a day per couple; blocks without a reply get a reaction (DR5, R31).
    const reset = nextQuotaReset(deps.now?.() ?? Date.now());
    const tzByLang = (lang) => {
      const member = context.members.find((m) => baseLang(m.lang) === lang);
      const time = new Intl.DateTimeFormat(lang, { timeZone: member?.tz ?? "UTC", hour: "2-digit", minute: "2-digit" }).format(
        new Date(reset),
      );
      return { reset: time };
    };
    key = `quota90:${coupleId}:${pacificDay(deps.now?.() ?? Date.now())}`; // parts get a :0 suffix
    const html = await groupText(context, "quota.level_90", {}, textFn, tzByLang);
    parts = [{ method: "sendMessage", params: { chat_id: context.groupChatId, text: html, parse_mode: "HTML", ...notification("quota") } }];
    outcome = "quota";
    await (deps.react ?? react)(context.groupChatId, fresh.at(-1).tg_message_id);
  } else {
    const html =
      (await groupText(context, "fallback.pause", {}, textFn)) + "\n\n" + (await groupText(context, "fallback.urgent_help", {}, textFn));
    parts = pauseMessages({ chatId: context.groupChatId, replyHtml: html });
    outcome = "fallback";
  }

  if (outcome === "spoke" && deps.offerCheck && context.escalation) {
    await deps.offerCheck({ context, windowId, parts });
  }

  const deliverFn = deps.deliver ?? deliver;
  let published = 0;
  for (const [index, part] of parts.entries()) {
    if (!(await store.canPublish(windowId, lease, context.stateVersion))) {
      // A pause, revocation or another transition during generation: drop it silently (R12).
      outcome = published ? `${outcome}_partial` : "dropped";
      break;
    }
    const args = toSendArgs(part);
    const r = await deliverFn(
      { key: `${key}:${index}`, scope: "group", coupleId, chatId: context.groupChatId, windowId, leaseId: lease, part: index, ...args },
      { store },
    );
    if (r.status === "sent" || r.status === "already_sent") published++;
    // Part 0 carries the helper's reply: keep it in the shared history (plain text,
    // addressee's language) so the next call knows what was said.
    if (index === 0 && outcome === "spoke" && r.status === "sent" && r.tgMessageId && helperText) {
      await store.ingestHelperReply({ coupleId, text: helperText, tgChatId: context.groupChatId, tgMessageId: r.tgMessageId });
    }
  }

  if (outcome === "spoke" && published > 0) await store.markFirstReply(windowId);
  // The marker moves on fallback too: at most one fallback per block.
  await finish(target);
  return { claimed: true, outcome, published };
}

// Limit announcements (DR5): switching to 70% and restoring features after the reset,
// at most once a day per couple; outbox keys make a repeat safe.
async function quotaNotices({ context, coupleId, usage, store, textFn, deps }) {
  const now = deps.now?.() ?? Date.now();
  const today = pacificDay(now);
  const yesterday = pacificDay(now - 24 * 3600 * 1000);
  const notices = [];

  if (usage >= 0.7) {
    const reset = nextQuotaReset(now);
    const tzByLang = (lang) => {
      const member = context.members.find((m) => baseLang(m.lang) === lang);
      return { reset: new Intl.DateTimeFormat(lang, { timeZone: member?.tz ?? "UTC", hour: "2-digit", minute: "2-digit" }).format(new Date(reset)) };
    };
    notices.push({ key: `quota70:${coupleId}:${today}`, html: await groupText(context, "quota.level_70", {}, textFn, tzByLang) });
  } else if (await store.outboundStatus(`quota90:${coupleId}:${yesterday}:0`)) {
    notices.push({ key: `quotaok:${coupleId}:${today}`, html: await groupText(context, "quota.restored", {}, textFn) });
  }

  for (const notice of notices) {
    await (deps.deliver ?? deliver)(
      {
        key: `${notice.key}:0`,
        scope: "group",
        coupleId,
        chatId: context.groupChatId,
        method: "sendMessage",
        params: { chat_id: context.groupChatId, text: notice.html, parse_mode: "HTML", ...notification("quota") },
      },
      { store },
    );
  }
}

async function react(chatId, messageId) {
  try {
    await call("setMessageReaction", { chat_id: chatId, message_id: messageId, reaction: [{ type: "emoji", emoji: WAITING_REACTION }] });
  } catch (error) {
    console.warn(`[session] реакция не поставлена: ${error.name}`);
  }
}

/**
 * A fired check: from the queue or after sleeping.
 * @param {(windowId: number, expectedMarker: number) => Promise<unknown>} deps.respond
 * @returns {Promise<"answered"|"superseded"|"respond">}
 */
export async function runCheck(check, { respond, store = db }) {
  // Transcriptions stuck past the ceiling become failed before deciding (R26).
  const coupleId = await store.windowCouple(check.windowId);
  if (coupleId !== null) await store.expireTranscripts(coupleId, TRANSCRIPT_DEADLINE_MS / 1000);
  const state = await store.debounceState(check.windowId);
  const decision = decide(state, check);
  if (decision === "respond") await respond(check.windowId, state.answeredUpTo);
  return decision;
}

// --- /check: speaker-listener (design doc "/check", R14, R16, DR6) ---
//
//   check_start ─▶ awaiting_paraphrase ─ listener replies to the hint ─▶ awaiting_verdict
//        ▲              │ "Skip" → skipped                               │ "I was understood" → understood
//        │              │ not a reply → one hint "reply to my message"   │ "Clarify meaning", round 1 ─▶ clarifying
//        │              ▼                                                │ "Clarify meaning", round 2 → discuss_more
//        └──── round 2 ◀── clarifying ─ the speaker's next message ◀─────┘
//   Any state: /cancel → cancelled; 10 minutes without progress → timeout (lazily).
//
// The reducer is pure: it returns the new state and effects. Effects carry text
// keys (catalog lib/copy/, T15), not the texts themselves.

export const CHECK_TIMEOUT_MS = 10 * 60 * 1000;
export const CHECK_ROUNDS = 2;

const ended = (outcome, effects) => ({ next: { ended: true, outcome }, effects: [{ type: "remove_buttons" }, ...effects] });

/**
 * @param {object} check checks row (the active one)
 * @param {object} event
 *   { type: "message", userId, replyToMessageId, messageId } — a partner's group message
 *   { type: "skip", userId } — the "Skip" button
 *   { type: "verdict", userId, understood: boolean } — the speaker's buttons
 *   { type: "cancel", userId } — /cancel
 *   { type: "tick", now } — any group update: lazy timeout check
 * @returns {{ next: object|null, effects: object[] }} next = null means the state doesn't change
 */
export function checkReducer(check, event) {
  const speaker = Number(check.speaker_user_id);
  const listener = Number(check.listener_user_id);
  const state = check.state;
  const round = Number(check.round);

  if (event.type === "tick") {
    const idle = event.now - new Date(check.updated_at).getTime();
    return idle > CHECK_TIMEOUT_MS ? ended("timeout", [{ type: "say", key: "check.timeout" }]) : { next: null, effects: [] };
  }

  if (event.type === "cancel") {
    if (event.userId !== speaker && event.userId !== listener) return { next: null, effects: [] };
    return ended("cancelled", [{ type: "say", key: "check.cancelled" }]);
  }

  if (event.type === "skip") {
    if (state !== "awaiting_paraphrase") return { next: null, effects: [{ type: "popup", key: "button.stale" }] };
    if (event.userId !== listener) return { next: null, effects: [{ type: "popup", key: "button.not_yours", userId: listener }] };
    return ended("skipped", [{ type: "say", key: "check.skipped" }]);
  }

  if (event.type === "verdict") {
    if (state !== "awaiting_verdict") return { next: null, effects: [{ type: "popup", key: "button.stale" }] };
    if (event.userId !== speaker) return { next: null, effects: [{ type: "popup", key: "button.not_yours", userId: speaker }] };
    if (event.understood) return ended("understood", [{ type: "say", key: "check.success" }]);
    if (round >= CHECK_ROUNDS) return ended("discuss_more", [{ type: "say", key: "check.discuss_more" }]);
    return {
      next: { state: "clarifying" },
      effects: [{ type: "remove_buttons" }, { type: "say", key: "check.clarify", userId: speaker }],
    };
  }

  if (event.type === "message") {
    if (state === "awaiting_paraphrase" && event.userId === listener) {
      const isReply = check.prompt_message_id !== null && Number(event.replyToMessageId) === Number(check.prompt_message_id);
      if (isReply) {
        return {
          next: { state: "awaiting_verdict" },
          effects: [
            { type: "remove_buttons" },
            // The paraphrase is translated for the speaker and shown with verdict buttons.
            { type: "show_paraphrase", messageId: event.messageId, text: event.text ?? null, to: speaker },
          ],
        };
      }
      // Only a reply counts as a paraphrase; the hint is given once (DR6.2).
      if (!check.hinted) return { next: { hinted: true }, effects: [{ type: "say", key: "check.reply_hint", userId: listener }] };
      return { next: null, effects: [] };
    }

    if (state === "clarifying" && event.userId === speaker) {
      return {
        next: { state: "awaiting_paraphrase", round: round + 1, hinted: false, prompt_message_id: null },
        effects: [{ type: "ask_paraphrase", to: listener, blockMessageId: event.messageId, round: round + 1 }],
      };
    }
  }

  return { next: null, effects: [] };
}

/**
 * Starting the exercise. A refusal honestly names the single reason (D15, D17).
 * @returns {{ ok: true, id, effects } | { ok: false, effects }}
 */
export async function startCheck({ coupleId, speaker, listener, blockFrom, blockTo }, { store = db } = {}) {
  const r = await store.checkStart(coupleId, speaker, listener, blockFrom, blockTo);
  if (!r.ok) {
    const effects =
      r.reason === "cooldown"
        ? [{ type: "say", key: "check.cooldown", minutes: r.retryInMinutes }]
        : [{ type: "say", key: "check.already_active" }];
    return { ok: false, effects };
  }
  return { ok: true, id: r.id, effects: [{ type: "ask_paraphrase", to: listener, blockFrom, blockTo, round: 1 }] };
}

/**
 * An event on the couple's active /check: reducer + conditional transition in the database.
 * If the transition didn't go through (button already pressed, state changed), the
 * effect is "This is no longer relevant" instead of side effects.
 * @returns {Promise<object[]>} effects to show
 */
export async function applyCheckEvent(coupleId, event, { store = db } = {}) {
  const check = await store.checkActive(coupleId);
  if (!check) {
    return event.type === "skip" || event.type === "verdict" ? [{ type: "popup", key: "button.stale" }] : [];
  }

  const { next, effects } = checkReducer(check, event);
  if (!next) return effects;

  const applied = await store.checkAdvance(check.id, { state: check.state, round: Number(check.round) }, next);
  if (!applied) return [{ type: "popup", key: "button.stale" }];
  return effects.map((effect) => ({ ...effect, checkId: check.id }));
}

/**
 * Whether to offer /check as a button after a pause reply (R16): escalation is only
 * a reason to offer it, never a refusal. With an active abuse flag the bot doesn't
 * offer it on its own; the /check command stays available (D15).
 */
export function shouldOfferCheck({ escalation, abuseFlagActive, checkActive }) {
  return Boolean(escalation) && !abuseFlagActive && !checkActive;
}

// --- Recap of a closed window (DR9, DR23, R30) ---

/**
 * The window closed after silence (on receiving a new message). One call gives the
 * recap and the summary; the recap is published only if the new window hasn't got a
 * reply from the helper yet (a late recap is dropped, R30); the summary is always updated.
 */
export async function recapWindow({ closedWindowId, newWindowId, couple }, deps = {}) {
  const store = deps.store ?? db;
  const langs = coupleLangs(couple.members);
  const { recap, reason } = await (deps.recapAndFold ?? recapAndFold)(closedWindowId, langs);
  if (!recap) return { published: false, reason };

  const fresh = await store.windowInfo(newWindowId);
  if (fresh?.firstReplyAt) {
    console.log(`[session] итог окна ${closedWindowId} опоздал — отброшен`);
    return { published: false, reason: "late" };
  }

  const byLang = new Map(recap.map((r) => [baseLang(r.lang), String(r.text ?? "").trim()]));
  const ordered = langs.filter((l) => byLang.get(l)).map((lang) => ({ lang, text: byLang.get(lang) }));
  if (!ordered.length) return { published: false, reason: "empty" };

  await (deps.deliver ?? deliver)(
    {
      key: `recap:${closedWindowId}`,
      scope: "group",
      coupleId: couple.id,
      chatId: couple.groupChatId,
      method: "sendMessage",
      params: {
        chat_id: couple.groupChatId,
        text: bilingual({ primary: ordered[0], secondary: ordered[1] }),
        parse_mode: "HTML",
        ...notification("recap"),
      },
    },
    { store },
  );
  return { published: true };
}
