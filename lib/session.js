// Окна разговора в группе: дебаунс «человек договорил» (R1, R11).
//
// Состояния пары (R6, R25, DR19) — переходы атомарно в SQL, couple_transition:
//
//               activate (/start + админ + 2 согласия)
//   onboarding ─────────────────────────────▶ active ◀── resume (только paused_by)
//                                               │  ▲
//                                         pause │  │
//                                               ▼  │
//                                             paused
//   active/paused/suspended ─ revoke ─▶ revoked ─ consent (оба) ─▶ paused, если paused_by / active
//   active/paused ─ suspend ─▶ suspended ─ restore ─▶ paused, если paused_by / active
//   active ─ crisis в группе ─▶ active
//
// Выход из active и crisis закрывают окно и отменяют /check; любое изменение
// поднимает state_version, и уже идущая генерация не публикуется (R12).
//
// Каждая реплика партнёра ставит отложенную проверку через DEBOUNCE_MS.
// Первая неотвеченная реплика блока дополнительно ставит проверку через
// MAX_WAIT_MS: в быстром споре бот не пропадает (дизайн-док, «Дебаунс»).
//
//   реплика ─▶ schedule(debounce, 20 с) ─┐
//          └▶ первая неотвеченная? ─ да ─▶ schedule(max_wait, 60 с)
//                                        ▼
//   runCheck ─▶ decide(состояние, проверка)
//                ├ answered   — блок уже покрыт ответом, ничего
//                ├ superseded — есть реплика новее: её проверка ответит
//                └ respond    — respond(окно, маркер) → аренда в базе
//
// Где ждать: отложенное сообщение Vercel Queues (delaySeconds). Если
// месячный бюджет Queues ≥ 90% или send упал — сон в waitUntil (фолбэк R1).
// Локально (bot.js) очереди нет — тот же сон, это и есть setTimeout-эмуляция.
//
// Ответ ведущего — respond ниже; runCheck получает его зависимостью, чтобы
// дебаунс тестировался отдельно. Хвост R11 возвращается из finish_reply и
// ставится через scheduleTail.

import * as db from "./db.js";
import { QUEUE_CUTOFF_PCT, QUEUE_MONTHLY_OPS, QUEUE_OPS_PER_MESSAGE } from "./ingest.js";
import { ContextRefused, buildGroupContext } from "./context.js";
import { PAUSE_SCHEMA, PAUSE_SYSTEM, normalizePause, pausePrompt } from "./counsel.js";
import { deadlineIn, generate } from "./gemini.js";
import { bilingual, notification, pauseMessages, toSendArgs } from "./format.js";
import { call, deliver } from "./telegram.js";
import { text as copyText } from "./copy.js";
import { handleSignal } from "./safety.js";

export const DEBOUNCE_TOPIC = "debounce";
export const DEBOUNCE_MS = Number(process.env.DEBOUNCE_MS ?? 20_000);
export const MAX_WAIT_MS = Number(process.env.MAX_WAIT_MS ?? 60_000);
// Потолок ожидания расшифровки голосового (R22, R26).
export const TRANSCRIPT_DEADLINE_MS = 120_000;

/**
 * Чистое решение по сработавшей проверке.
 * @param {{answeredUpTo: number, latestId: number|null, ended?: boolean, checkActive?: boolean, pendingTranscripts?: number}} state
 * @param {{kind: "debounce"|"max_wait"|"transcript_deadline", messageId: number}} check
 * @returns {"answered"|"superseded"|"respond"|"check_active"|"waiting_transcript"}
 */
export function decide(state, check) {
  if (!state || state.ended || state.latestId === null) return "answered";
  // Пока идёт /check, ведущий не отвечает по дебаунсу (дизайн-док «/check»).
  if (state.checkActive) return "check_active";
  // Ответ ведущего ждёт расшифровку голосовых блока (R22). Разбудит конец
  // расшифровки или проверка на потолке ожидания.
  if (state.pendingTranscripts > 0) return "waiting_transcript";

  if (check.kind === "max_wait") {
    // Блок, начатый этой репликой, уже покрыт — дальше отвечают свои проверки.
    return state.answeredUpTo >= check.messageId ? "answered" : "respond";
  }
  if (check.kind === "transcript_deadline") {
    // Потолок ожидания: к этому моменту зависшие расшифровки уже failed.
    return state.answeredUpTo >= state.latestId ? "answered" : "respond";
  }

  if (state.answeredUpTo >= state.latestId) return "answered";
  // Пришла реплика новее: у неё своя проверка, она и ответит после паузы.
  if (state.latestId > check.messageId) return "superseded";
  return "respond";
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ставит одну проверку. Возвращает "queue" или "sleep" — каким путём.
 * @param {{windowId: number, messageId: number, kind: string}} check
 * @param {number} delayMs
 * @param {object} deps
 * @param {Function} [deps.enqueue] send в Vercel Queues; нет — сразу сон
 * @param {(promise: Promise<unknown>) => void} deps.defer waitUntil / фон
 * @param {(check: object) => Promise<unknown>} deps.run выполнение проверки
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
          // Повторная обработка той же реплики не ставит вторую проверку.
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
 * Реплика партнёра в группе сохранена — ставим проверки.
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
 * Голосовое или кружок в группе: обычные проверки плюс проверка на потолке
 * ожидания расшифровки (R26) — она сработает, даже если новых реплик не будет.
 */
export async function onVoiceMessage({ windowId, messageId }, deps) {
  await onPartnerMessage({ windowId, messageId }, deps);
  await schedule({ windowId, messageId, kind: "transcript_deadline" }, TRANSCRIPT_DEADLINE_MS + 1_000, deps);
}

/**
 * Расшифровка готова. Статус меняется один раз (R26):
 *   вовремя — проверка дебаунса на последнюю реплику, но не раньше паузы;
 *   поздно (уже failed) — текст сохранён с late, ведущего не будим.
 * Публикация транскрипта (DR25) — забота вызывающего; late её не отменяет.
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

// Хвост R11: finish_reply сообщил о реплике, пришедшей во время генерации.
export async function scheduleTail(windowId, messageId, deps) {
  return schedule({ windowId, messageId, kind: "debounce" }, DEBOUNCE_MS, deps);
}

// --- Ответ ведущего после паузы (R2, R12, R13, R20, R29, R30, R31, DR23) ---
//
//   аренда ─ нет ─▶ выход (окно занято или маркер сдвинут)
//     │
//     ▼
//   цель = последняя новая реплика; ключ pause:<окно>:<цель>:<часть>
//     │ часть 0 уже отправлена упавшей задачей ─▶ только finish_reply
//     ▼
//   контекст (пара не active ─▶ finish без ответа)
//     ▼
//   один вызов модели (бюджет = аренда − 15 с)
//     ├ ok ─ safety crisis/abuse ─▶ onSafety, обычный ответ не публикуется
//     │    └ части: ответ (speak) + переводы (R29)
//     ├ blocked crisis ─▶ onSafety;  blocked neutral ─▶ нейтральный фолбэк
//     ├ quota ─▶ объявление раз в сутки (ключ quota90:<пара>:<день>) + 👀
//     └ error ─▶ фолбэк «попробуйте пересказать» + «Срочная помощь: /help» (DR14)
//     ▼
//   перед каждой частью can_publish (R12); части через outbox (R13)
//     ▼
//   finish_reply(цель) ─ хвост ─▶ scheduleTail (R11)

export const LEASE_SECONDS = 90;
const GENERATION_BUDGET_MS = (LEASE_SECONDS - 15) * 1000;
const WAITING_REACTION = "👀";

const baseLang = (lang) => String(lang ?? "en").split(/[-_]/)[0].toLowerCase();

// Языки пары: адресат первым (DR1), дальше порядок участников, без повторов.
export function coupleLangs(members, addresseeUserId = null) {
  const ordered = [...members].sort((a, b) =>
    a.userId === addresseeUserId ? -1 : b.userId === addresseeUserId ? 1 : 0,
  );
  return [...new Set(ordered.map((m) => baseLang(m.lang)))];
}

// Ближайшая полночь по тихоокеанскому времени — сброс квоты Gemini.
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
 * @param {number} expectedMarker маркер, прочитанный при решении
 * @param {object} [deps] зависимости для тестов и связывания
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

  // Упавшая после отправки задача: ответ уже в группе, только завершаем (R13).
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
    if (!html && pause.speakRequested) html = await groupText(context, "fallback.neutral_block", {}, textFn);
    parts = pauseMessages({ chatId: context.groupChatId, replyHtml: html, translations: pause.translations });
    outcome = pause.speak ? "spoke" : "silent";
    context.escalation = pause.escalation;
  } else if (result.blocked === "crisis") {
    await (deps.onSafety ?? handleSignal)({ context, windowId, signal: "crisis", surface: "group" });
    await finish(target);
    return { claimed: true, outcome: "crisis" };
  } else if (result.blocked === "neutral") {
    parts = pauseMessages({ chatId: context.groupChatId, replyHtml: await groupText(context, "fallback.neutral_block", {}, textFn) });
    outcome = "neutral_block";
  } else if (result.unavailable === "quota") {
    // Объявление раз в сутки на пару; блоки без ответа получают реакцию (DR5, R31).
    const reset = nextQuotaReset(deps.now?.() ?? Date.now());
    const tzByLang = (lang) => {
      const member = context.members.find((m) => baseLang(m.lang) === lang);
      const time = new Intl.DateTimeFormat(lang, { timeZone: member?.tz ?? "UTC", hour: "2-digit", minute: "2-digit" }).format(
        new Date(reset),
      );
      return { reset: time };
    };
    key = `quota90:${coupleId}:${pacificDay(deps.now?.() ?? Date.now())}`;
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
      // Пауза, отзыв или новый переход во время генерации — молча выбрасываем (R12).
      outcome = published ? `${outcome}_partial` : "dropped";
      break;
    }
    const args = toSendArgs(part);
    const r = await deliverFn(
      { key: `${key}:${index}`, scope: "group", coupleId, chatId: context.groupChatId, windowId, leaseId: lease, part: index, ...args },
      { store },
    );
    if (r.status === "sent" || r.status === "already_sent") published++;
  }

  if (outcome === "spoke" && published > 0) await store.markFirstReply(windowId);
  // Маркер сдвигается и при фолбэке: на один блок — не больше одного фолбэка.
  await finish(target);
  return { claimed: true, outcome, published };
}

async function react(chatId, messageId) {
  try {
    await call("setMessageReaction", { chat_id: chatId, message_id: messageId, reaction: [{ type: "emoji", emoji: WAITING_REACTION }] });
  } catch (error) {
    console.warn(`[session] реакция не поставлена: ${error.name}`);
  }
}

/**
 * Сработавшая проверка: из очереди или после сна.
 * @param {(windowId: number, expectedMarker: number) => Promise<unknown>} deps.respond
 * @returns {Promise<"answered"|"superseded"|"respond">}
 */
export async function runCheck(check, { respond, store = db }) {
  // Зависшие дольше потолка расшифровки становятся failed до решения (R26).
  const coupleId = await store.windowCouple(check.windowId);
  if (coupleId !== null) await store.expireTranscripts(coupleId, TRANSCRIPT_DEADLINE_MS / 1000);
  const state = await store.debounceState(check.windowId);
  const decision = decide(state, check);
  if (decision === "respond") await respond(check.windowId, state.answeredUpTo);
  return decision;
}

// --- /check: speaker-listener (дизайн-док «/check», R14, R16, DR6) ---
//
//   check_start ─▶ awaiting_paraphrase ─ реплай слушающего на подсказку ─▶ awaiting_verdict
//        ▲              │ «Пропустить» → skipped                            │ «Меня поняли верно» → understood
//        │              │ не реплай → одна подсказка «ответь реплаем»       │ «Уточнить смысл», раунд 1 ─▶ clarifying
//        │              ▼                                                   │ «Уточнить смысл», раунд 2 → discuss_more
//        └──── раунд 2 ◀── clarifying ─ следующее сообщение говорящего ◀────┘
//   Любое состояние: /cancel → cancelled; 10 минут без движения → timeout (лениво).
//
// Редьюсер чистый: возвращает новое состояние и эффекты. Эффекты несут ключи
// текстов (каталог lib/copy/ — T15), а не сами тексты.

export const CHECK_TIMEOUT_MS = 10 * 60 * 1000;
export const CHECK_ROUNDS = 2;

const ended = (outcome, effects) => ({ next: { ended: true, outcome }, effects: [{ type: "remove_buttons" }, ...effects] });

/**
 * @param {object} check строка checks (активная)
 * @param {object} event
 *   { type: "message", userId, replyToMessageId, messageId } — реплика партнёра в группе
 *   { type: "skip", userId } — кнопка «Пропустить»
 *   { type: "verdict", userId, understood: boolean } — кнопки говорящего
 *   { type: "cancel", userId } — /cancel
 *   { type: "tick", now } — любой апдейт группы: ленивая проверка таймаута
 * @returns {{ next: object|null, effects: object[] }} next = null — состояние не меняется
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
            // Пересказ переводится для говорящего и показывается с кнопками вердикта.
            { type: "show_paraphrase", messageId: event.messageId, text: event.text ?? null, to: speaker },
          ],
        };
      }
      // Пересказом считается только реплай; подсказка — один раз (DR6.2).
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
 * Запуск упражнения. Отказ называет единственную причину честно (D15, D17).
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
 * Событие по активному /check пары: редьюсер + условный переход в базе.
 * Если переход не прошёл (кнопку уже нажали, состояние сменилось) — эффект
 * «Это уже неактуально» вместо побочных действий.
 * @returns {Promise<object[]>} эффекты для показа
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
 * Предлагать ли /check кнопкой после ответа паузы (R16): escalation — только
 * повод предложить, не отказ. При активном абьюз-флаге бот сам не предлагает;
 * по команде /check остаётся доступен (D15).
 */
export function shouldOfferCheck({ escalation, abuseFlagActive, checkActive }) {
  return Boolean(escalation) && !abuseFlagActive && !checkActive;
}
