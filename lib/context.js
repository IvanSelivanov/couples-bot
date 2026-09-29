// The ONLY place that builds context for the model (design doc, "Boundary in
// code"; R15). The data boundary:
//
//   context      | summaries           | messages                   | notes
//   -------------+---------------------+----------------------------+-------------------
//   group/guest  | group               | group + guest (40)         | active, both
//   dm X         | dm:X, group         | dm X (40), group+guest (40)| active, both
//   dm X, when   | dm:X                | dm X (40)                  | none
//   Y revoked    |                     |                            |
//
// Never, in any context: Y's private chat, the dm:Y summary, drafts.
// Notes aren't part of summaries and are re-read on every call, so a revoked
// note disappears from the very next context (R15).
//
// Private chat text and dm:* summaries are stored as ciphertext with aad
// "dm:<owner>": a row of someone else's chat can't be decrypted under another owner.

import { contextReads, deleteCoveredDm, upsertSummary, windowInfo } from "./db.js";
import { decrypt, encrypt } from "./crypto.js";
import { generate } from "./gemini.js";
import { FOLD_SCHEMA, FOLD_SYSTEM, RECAP_SCHEMA, RECAP_SYSTEM, foldPrompt } from "./counsel.js";

export const CONTEXT_MESSAGES = 40;

export class ContextRefused extends Error {}

const dmAad = (userId) => `dm:${userId}`;

function openDmMessage(row, ownerUserId) {
  return { ...row, text: row.text === null ? null : decrypt(row.text, dmAad(ownerUserId)) };
}

/**
 * Context for the shared surface: the helper's reply, @mentions, Guest Mode.
 * The couple must be active: in any other state the bot is silent in the group.
 */
export async function buildGroupContext(coupleId, { reads = contextReads } = {}) {
  const couple = await reads.couple(coupleId);
  if (!couple) throw new ContextRefused("пары нет");
  if (couple.state !== "active") throw new ContextRefused(`пара в состоянии ${couple.state}`);

  const [summary, messages, notes, members, abuseFlagActive] = await Promise.all([
    reads.summary(coupleId, "group"),
    reads.sharedMessages(coupleId, CONTEXT_MESSAGES),
    reads.activeNotes(coupleId),
    reads.members(coupleId),
    reads.abuseFlagActive(coupleId),
  ]);

  return {
    surface: "group",
    coupleId,
    groupChatId: couple.group_chat_id,
    autoTranslate: couple.auto_translate,
    stateVersion: couple.state_version,
    members: members.map((m) => ({ userId: Number(m.user_id), lang: m.lang, name: m.display_name, tz: m.tz })),
    abuseFlagActive,
    summaries: { group: summary?.text ?? null },
    shared: messages,
    dm: [],
    notes,
  };
}

/**
 * Context for the private chat of ownerUserId.
 * If the owner revoked consent themselves: refused (the private chat only answers
 * /consent and /forget). If the partner revoked: only the owner's own chat, since
 * the shared history and notes contain the partner's data.
 */
export async function buildDmContext(coupleId, ownerUserId, { reads = contextReads } = {}) {
  const [couple, members] = await Promise.all([reads.couple(coupleId), reads.members(coupleId)]);
  if (!couple) throw new ContextRefused("пары нет");

  const owner = members.find((m) => Number(m.user_id) === Number(ownerUserId));
  if (!owner) throw new ContextRefused("не участник пары");
  if (owner.revoked_at) throw new ContextRefused("владелец отозвал согласие");

  const partnerRevoked = members.some((m) => Number(m.user_id) !== Number(ownerUserId) && m.revoked_at);

  const abuseFlagActive = await reads.abuseFlagActive(coupleId);
  const dmSummaryRow = await reads.summary(coupleId, dmAad(ownerUserId));
  const dmRows = await reads.dmMessages(coupleId, ownerUserId, CONTEXT_MESSAGES);
  const dm = dmRows.map((row) => openDmMessage(row, ownerUserId));
  const dmSummary = dmSummaryRow ? decrypt(dmSummaryRow.text, dmAad(ownerUserId)) : null;

  if (partnerRevoked) {
    return {
      surface: "dm",
      ownerUserId,
      stateVersion: couple.state_version,
      abuseFlagActive,
      summaries: { dm: dmSummary, group: null },
      shared: [],
      dm,
      notes: [],
    };
  }

  const [groupSummary, shared, notes] = await Promise.all([
    reads.summary(coupleId, "group"),
    reads.sharedMessages(coupleId, CONTEXT_MESSAGES),
    reads.activeNotes(coupleId),
  ]);

  return {
    surface: "dm",
    ownerUserId,
    stateVersion: couple.state_version,
    abuseFlagActive,
    summaries: { dm: dmSummary, group: groupSummary?.text ?? null },
    shared,
    dm,
    notes,
  };
}

// --- Folding summaries (design doc "Context budget"; DR9, DR22, R15, R30) ---
//
// Reads raw messages, so it lives here, inside the data boundary.
// Notes are never fed in (R15). A private chat summary is encrypted with aad dm:X.

function namesOf(members) {
  return new Map(members.map((m) => [Number(m.user_id), m.display_name]));
}

/** Folds the couple's shared history. Returns { folded, coversUpTo } or { folded: false, reason }. */
export async function foldGroup(coupleId, { reads = contextReads, generateFn = generate, store = { upsertSummary } } = {}) {
  const previous = await reads.summary(coupleId, "group");
  const messages = await reads.unsummarized(coupleId, { scope: "group", after: previous?.covers_up_to ?? 0 });
  if (!messages.length) return { folded: false, reason: "nothing" };
  const members = await reads.members(coupleId);
  const r = await generateFn({
    purpose: "fold",
    system: FOLD_SYSTEM,
    parts: [{ text: foldPrompt({ previous: previous?.text, messages, names: namesOf(members) }) }],
    schema: FOLD_SCHEMA,
  });
  if (!r.ok) return { folded: false, reason: r.unavailable ?? r.blocked };
  const coversUpTo = Math.max(...messages.map((m) => Number(m.id)));
  await store.upsertSummary(coupleId, "group", String(r.data.summary).trim(), coversUpTo);
  return { folded: true, coversUpTo };
}

/** Folds the owner's private chat and deletes the covered rows (DR22). */
export async function foldDm(coupleId, ownerUserId, { reads = contextReads, generateFn = generate, store = { upsertSummary, deleteCoveredDm } } = {}) {
  const previousRow = await reads.summary(coupleId, dmAad(ownerUserId));
  const previous = previousRow ? decrypt(previousRow.text, dmAad(ownerUserId)) : null;
  const rows = await reads.unsummarized(coupleId, { scope: "dm", ownerUserId, after: previousRow?.covers_up_to ?? 0 });
  if (!rows.length) return { folded: false, reason: "nothing" };
  const messages = rows.map((row) => openDmMessage(row, ownerUserId));
  const members = await reads.members(coupleId);
  const r = await generateFn({
    purpose: "fold",
    system: FOLD_SYSTEM,
    parts: [{ text: foldPrompt({ previous, messages, names: namesOf(members) }) }],
    schema: FOLD_SCHEMA,
  });
  if (!r.ok) return { folded: false, reason: r.unavailable ?? r.blocked };
  const coversUpTo = Math.max(...rows.map((m) => Number(m.id)));
  await store.upsertSummary(coupleId, dmAad(ownerUserId), encrypt(String(r.data.summary).trim(), dmAad(ownerUserId)), coversUpTo);
  await store.deleteCoveredDm(coupleId, ownerUserId, coversUpTo);
  return { folded: true, coversUpTo };
}

/**
 * Recap of a closed window and a new summary in one call (DR9). A recap is needed only
 * if the window had a reply from the helper (DR23); otherwise the window closes
 * quietly and cron folds the summary by threshold.
 * @returns {Promise<{recap: Array<{lang, text}>|null, reason?: string}>}
 */
export async function recapAndFold(windowId, langs, { reads = contextReads, generateFn = generate, store = { upsertSummary, windowInfo } } = {}) {
  const info = await store.windowInfo(windowId);
  if (!info?.endedAt) return { recap: null, reason: "open" };
  if (!info.firstReplyAt) return { recap: null, reason: "silent_window" };

  const previous = await reads.summary(info.coupleId, "group");
  const windowMessages = await reads.windowMessages(info.coupleId, info.startedAt, info.endedAt);
  const lastId = windowMessages.length ? Math.max(...windowMessages.map((m) => Number(m.id))) : 0;
  const pending = (await reads.unsummarized(info.coupleId, { scope: "group", after: previous?.covers_up_to ?? 0 })).filter(
    (m) => Number(m.id) <= lastId,
  );
  if (!pending.length) return { recap: null, reason: "nothing" };

  const members = await reads.members(info.coupleId);
  const r = await generateFn({
    purpose: "recap",
    system: RECAP_SYSTEM,
    parts: [
      {
        text: foldPrompt({
          previous: previous?.text,
          messages: pending,
          names: namesOf(members),
          windowIds: new Set(windowMessages.map((m) => Number(m.id))),
          langs,
        }),
      },
    ],
    schema: RECAP_SCHEMA,
  });
  if (!r.ok) return { recap: null, reason: r.unavailable ?? r.blocked };
  await store.upsertSummary(info.coupleId, "group", String(r.data.summary).trim(), Math.max(...pending.map((m) => Number(m.id))));
  return { recap: r.data.recap ?? [] };
}

// --- Re-encryption after key rotation (R18, T12) ---
//
// After DM_ENCRYPTION_KEY changes (old → DM_ENCRYPTION_KEY_PREV, version +1)
// cron rewrites old-version ciphertexts with the current key, in batches.

export async function reencryptBatch({ reads = contextReads } = {}) {
  const version = Number(process.env.DM_ENCRYPTION_KEY_VERSION ?? 1);
  const stale = await reads.staleCiphertexts(version);
  const again = (token, aad) => (token && !token.startsWith(`v${version}.`) ? encrypt(decrypt(token, aad), aad) : token);
  let count = 0;

  for (const m of stale.messages) {
    await reads.rewriteCiphertext("messages", { id: m.id }, { text: again(m.text, dmAad(m.owner_user_id)) });
    count++;
  }
  for (const s of stale.summaries) {
    await reads.rewriteCiphertext("summaries", { couple_id: s.couple_id, scope_key: s.scope_key }, { text: again(s.text, s.scope_key) });
    count++;
  }
  for (const n of stale.notes) {
    await reads.rewriteCiphertext("notes", { id: n.id }, { text: again(n.text, `note:${n.author_user_id}`) });
    count++;
  }
  for (const d of stale.drafts) {
    const aad = `draft:${d.user_id}`;
    await reads.rewriteCiphertext("drafts", { id: d.id }, {
      original: again(d.original, aad),
      reformulated: again(d.reformulated, aad),
      translations: again(d.translations, aad),
    });
    count++;
  }
  for (const u of stale.updates) {
    await reads.rewriteCiphertext("processed_updates", { update_id: u.update_id }, { payload: again(u.payload, `update:${u.update_id}`) });
    count++;
  }
  return count;
}
