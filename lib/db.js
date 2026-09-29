// Supabase access through PostgREST on the global fetch, no SDK.
//
// Data boundary (design doc, "Boundary in code"): this module doesn't export
// raw reads of messages, notes, summaries and drafts. Only lib/context.js and
// lib/draft.js read them, through the dedicated objects below.

export class DbError extends Error {}

function config() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new DbError("SUPABASE_URL или SUPABASE_SERVICE_KEY не заданы");
  return { url: url.replace(/\/$/, ""), key };
}

async function request(path, { method = "GET", body, headers = {}, timeoutMs = 10_000 } = {}) {
  const { url, key } = config();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const text = await response.text();
  if (!response.ok) {
    // A PostgREST error body describes the SQL problem and contains no row data.
    throw new DbError(`${method} ${path.split("?")[0]}: HTTP ${response.status} ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;
}

export async function rpc(name, args) {
  return request(`rpc/${name}`, { method: "POST", body: args });
}

// --- Update intake (R3, R10, R19, R27) ---

// Monthly Vercel Queues operations budget (R1). true means we may use the queue.
export async function queueBudgetTake(ops, monthlyLimit, cutoffPct) {
  return rpc("queue_budget_take", { p_ops: ops, p_monthly_limit: monthlyLimit, p_cutoff_pct: cutoffPct });
}

// Records receipt of an update. Returns the row's status after the insert:
// "received" is new or not yet processed, "done" is already processed.
// payload (ciphertext) is written only in the fallback without the queue.
export async function markReceived(updateId, payload = null) {
  const inserted = await request("processed_updates?on_conflict=update_id", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
    body: { update_id: updateId, status: "received", payload },
  });
  if (inserted.length > 0) return "received";

  const [existing] = await request(`processed_updates?update_id=eq.${Number(updateId)}&select=status`);
  return existing?.status ?? "received";
}

// Done: status done, payload wiped (R27).
export async function markDone(updateId) {
  await request(`processed_updates?update_id=eq.${Number(updateId)}`, {
    method: "PATCH",
    body: { status: "done", payload: null },
  });
}

// --- Gemini quota (R20, R31) ---

// { allowed, used }: allowed = false means the call's tier is already exhausted.
export async function quotaTake(dailyLimit, cutoffPct) {
  return rpc("quota_take", { p_daily_limit: dailyLimit, p_cutoff_pct: cutoffPct });
}

// --- Couple by chat and by member ---

const COUPLE_COLUMNS = "id,group_chat_id,state,state_version,auto_translate,paused_by";
const MEMBER_COLUMNS = "user_id,lang,display_name,tz,country,consented_at,revoked_at,last_note_offer_at";

function coupleWithMembers(couple, members) {
  if (!couple) return null;
  return {
    id: Number(couple.id),
    groupChatId: couple.group_chat_id === null ? null : Number(couple.group_chat_id),
    state: couple.state,
    stateVersion: couple.state_version,
    autoTranslate: couple.auto_translate,
    pausedBy: couple.paused_by === null ? null : Number(couple.paused_by),
    members: members.map((m) => ({
      userId: Number(m.user_id),
      lang: m.lang,
      name: m.display_name,
      tz: m.tz,
      country: m.country,
      consentedAt: m.consented_at,
      revokedAt: m.revoked_at,
      lastNoteOfferAt: m.last_note_offer_at ?? null,
    })),
  };
}

export async function coupleByChat(chatId) {
  const [couple] = await request(`couples?group_chat_id=eq.${Number(chatId)}&select=${COUPLE_COLUMNS}`);
  if (!couple) return null;
  const members = await request(`members?couple_id=eq.${couple.id}&select=${MEMBER_COLUMNS}`);
  return coupleWithMembers(couple, members);
}

export async function coupleById(coupleId) {
  const [couple] = await request(`couples?id=eq.${Number(coupleId)}&select=${COUPLE_COLUMNS}`);
  if (!couple) return null;
  const members = await request(`members?couple_id=eq.${couple.id}&select=${MEMBER_COLUMNS}`);
  return coupleWithMembers(couple, members);
}

export async function coupleByMember(userId) {
  const [member] = await request(`members?user_id=eq.${Number(userId)}&select=couple_id`);
  if (!member) return null;
  const [couple] = await request(`couples?id=eq.${member.couple_id}&select=${COUPLE_COLUMNS}`);
  const members = await request(`members?couple_id=eq.${member.couple_id}&select=${MEMBER_COLUMNS}`);
  return coupleWithMembers(couple, members);
}

// --- Onboarding (DR7, DR8) ---

export async function createCoupleForChat(chatId) {
  const rows = await request("couples?on_conflict=group_chat_id", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
    body: { group_chat_id: chatId, state: "onboarding" },
  });
  if (rows.length) return Number(rows[0].id);
  const [row] = await request(`couples?group_chat_id=eq.${Number(chatId)}&select=id`);
  return Number(row.id);
}

// { ok, existing } | { ok: false, reason: "full" | "other_couple" }
export async function joinCouple(coupleId, userId, name, langHint) {
  return rpc("join_couple", { p_couple_id: coupleId, p_user_id: userId, p_name: name, p_lang_hint: langHint });
}

export async function memberUpdate(userId, patch) {
  await request(`members?user_id=eq.${Number(userId)}`, { method: "PATCH", body: patch });
}

export async function memberGet(userId) {
  const [row] = await request(
    `members?user_id=eq.${Number(userId)}&select=user_id,couple_id,lang,display_name,tz,country,onboarding_step,consented_at,revoked_at,last_note_offer_at`,
  );
  return row ?? null;
}

// { ok, coupleId, activated }
export async function giveConsent(userId) {
  const r = await rpc("give_consent", { p_user_id: userId });
  return { ok: r.ok, reason: r.reason, coupleId: r.couple_id === undefined ? null : Number(r.couple_id), activated: Boolean(r.activated) };
}

export async function setStatusMessage(coupleId, messageId) {
  await request(`couples?id=eq.${Number(coupleId)}`, { method: "PATCH", body: { status_message_id: messageId } });
}

export async function statusMessageId(coupleId) {
  const [row] = await request(`couples?id=eq.${Number(coupleId)}&select=status_message_id`);
  return row?.status_message_id ? Number(row.status_message_id) : null;
}

// --- Private chat (T23, R24, R27) ---

// Inserts a private message (text is ciphertext) and deletes the owner's rows
// older than 6 days. Returns the id, or null when the update is repeated.
export async function ingestDmMessage({ coupleId, ownerUserId, authorUserId, isBot, tgMessageId, text, kind = "text" }) {
  const id = await rpc("ingest_dm_message", {
    p_couple_id: coupleId,
    p_owner: ownerUserId,
    p_author: authorUserId ?? null,
    p_is_bot: Boolean(isBot),
    p_tg_message_id: tgMessageId ?? null,
    p_text: text,
    p_kind: kind,
  });
  return id === null ? null : Number(id);
}

// Messages from the couple's confirmed 1:1 chat in Guest Mode (both see them anyway).
export async function ingestGuestMessage({ coupleId, authorUserId, tgChatId, tgMessageId, text }) {
  await request("messages?on_conflict=couple_id,scope,tg_chat_id,tg_message_id", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates" },
    body: { couple_id: coupleId, scope: "guest", author_user_id: authorUserId, tg_chat_id: tgChatId, tg_message_id: tgMessageId, text },
  });
}

// A sent draft: a shared-history message from the bot on the author's behalf (DR10).
export async function ingestSharedBotMessage({ coupleId, authorUserId, text }) {
  await request("messages", {
    method: "POST",
    body: { couple_id: coupleId, scope: "group", author_user_id: authorUserId, is_bot: true, text },
  });
}

export async function markNoteOffered(userId) {
  await request(`members?user_id=eq.${Number(userId)}`, { method: "PATCH", body: { last_note_offer_at: new Date().toISOString() } });
}

export async function setAutoTranslate(coupleId, on) {
  await request(`couples?id=eq.${Number(coupleId)}`, { method: "PATCH", body: { auto_translate: Boolean(on) } });
}

// --- Deletion on request (DR16, DR20, R15) ---

export async function forgetMember(userId) {
  return rpc("forget_member", { p_user_id: userId });
}

export async function forgetGroup(coupleId) {
  return rpc("forget_group", { p_couple_id: coupleId });
}

export async function flagClear(userId) {
  return rpc("flag_clear", { p_user_id: userId });
}

export async function hasOwnSignal(userId) {
  return rpc("has_own_signal", { p_user_id: userId });
}

// --- Abuse flags (DR20) ---

// A new signal adds a row rather than overwriting the old one (design doc).
export async function addAbuseFlag(coupleId, source) {
  await request("abuse_flags", { method: "POST", body: { couple_id: coupleId, source } });
}

// --- Help-line numbers by country (DR21) ---

export async function helpLinesGet(countries) {
  if (countries.length === 0) return [];
  const list = countries.map((c) => encodeURIComponent(c)).join(",");
  return request(`help_lines?country=in.(${list})&select=country,lines,fetched_at,status`);
}

export async function helpLinesPut(country, lines, status) {
  await request("help_lines?on_conflict=country", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: { country, lines, status, fetched_at: new Date().toISOString() },
  });
}

// Countries whose cache is stale or failed to build, for the monthly cron.
export async function helpLinesStale(olderThanDays) {
  const since = new Date(Date.now() - olderThanDays * 24 * 3600 * 1000).toISOString();
  const rows = await request(`help_lines?or=(fetched_at.lt.${since},status.eq.failed)&select=country`);
  return rows.map((r) => r.country);
}

export async function coupleCountries(coupleId) {
  const rows = await request(`members?couple_id=eq.${Number(coupleId)}&country=not.is.null&select=country`);
  return [...new Set(rows.map((r) => r.country))];
}

// --- Translation cache for fixed texts (DR15, R23, TD1) ---

export async function copyCacheGet(lang, key) {
  const [row] = await request(
    `copy_cache?lang=eq.${encodeURIComponent(lang)}&key=eq.${encodeURIComponent(key)}&select=text,source_hash,reviewed,stale`,
  );
  return row ?? null;
}

// A new machine translation. If the key was proofread by a human and the source
// changed, the row is marked stale: the proofreading must be redone (R23).
export async function copyCachePut({ lang, key, text, sourceHash, wasReviewed }) {
  await request("copy_cache?on_conflict=lang,key", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: {
      lang,
      key,
      text,
      source_hash: sourceHash,
      reviewed: false,
      stale: Boolean(wasReviewed),
      updated_at: new Date().toISOString(),
    },
  });
  if (wasReviewed) console.warn(`[copy] вычитанный перевод устарел: ${lang}/${key}`);
}

// --- Raw reads for context (data boundary) ---
//
// Only lib/context.js and lib/draft.js may import contextReads; the static
// test test/unit/boundary.test.js enforces it. Every function reads narrowly:
// the scope boundary is set by the query, not by filtering after the read.

const MESSAGE_COLUMNS =
  "id,scope,owner_user_id,author_user_id,is_bot,kind,tg_message_id,text,lang,transcript_status,addresses_bot,created_at";

export const contextReads = {
  async couple(coupleId) {
    const [row] = await request(
      `couples?id=eq.${Number(coupleId)}&select=id,state,state_version,group_chat_id,auto_translate`,
    );
    return row ?? null;
  },

  async members(coupleId) {
    return request(`members?couple_id=eq.${Number(coupleId)}&select=user_id,lang,display_name,tz,revoked_at`);
  },

  async summary(coupleId, scopeKey) {
    const [row] = await request(
      `summaries?couple_id=eq.${Number(coupleId)}&scope_key=eq.${encodeURIComponent(scopeKey)}&select=text,covers_up_to`,
    );
    return row ?? null;
  },

  // Shared history: group and guest together, the last `limit`, by ascending id.
  async sharedMessages(coupleId, limit) {
    const rows = await request(
      `messages?couple_id=eq.${Number(coupleId)}&scope=in.(group,guest)&select=${MESSAGE_COLUMNS}&order=id.desc&limit=${Number(limit)}`,
    );
    return rows.reverse();
  },

  // Exactly one owner's private chat.
  async dmMessages(coupleId, ownerUserId, limit) {
    const rows = await request(
      `messages?couple_id=eq.${Number(coupleId)}&scope=eq.dm&owner_user_id=eq.${Number(ownerUserId)}&select=${MESSAGE_COLUMNS}&order=id.desc&limit=${Number(limit)}`,
    );
    return rows.reverse();
  },

  // Is there an active abuse flag: with one, the bot doesn't "balance the sides" and
  // doesn't suggest exercises on its own. The flag holds no conversation text.
  async abuseFlagActive(coupleId) {
    const rows = await request(`abuse_flags?couple_id=eq.${Number(coupleId)}&cleared_at=is.null&select=id&limit=1`);
    return rows.length > 0;
  },

  // Messages of a conversation window for the recap (R30): group and guest between the window's start and end.
  async windowMessages(coupleId, startedAt, endedAt) {
    return request(
      `messages?couple_id=eq.${Number(coupleId)}&scope=in.(group,guest)&created_at=gte.${encodeURIComponent(startedAt)}&created_at=lte.${encodeURIComponent(endedAt)}&select=${MESSAGE_COLUMNS}&order=id.asc&limit=400`,
    );
  },

  // Unfolded messages of a scope (newer than covers_up_to), by ascending id.
  async unsummarized(coupleId, { scope, ownerUserId = null, after = 0, limit = 400 }) {
    const scopeFilter = scope === "dm" ? `scope=eq.dm&owner_user_id=eq.${Number(ownerUserId)}` : "scope=in.(group,guest)";
    return request(
      `messages?couple_id=eq.${Number(coupleId)}&${scopeFilter}&id=gt.${Number(after)}&select=${MESSAGE_COLUMNS}&order=id.asc&limit=${Number(limit)}`,
    );
  },

  // Ciphertexts not on the current key version, for re-encryption in cron (R18).
  // Approved notes are plain text and are left alone.
  async staleCiphertexts(version, limit = 200) {
    const notCurrent = `not.like.v${Number(version)}.*`;
    const [messages, summaries, notes, drafts, updates] = await Promise.all([
      request(`messages?scope=eq.dm&text=${notCurrent}&text=not.is.null&select=id,owner_user_id,text&limit=${limit}`),
      request(`summaries?scope_key=like.dm:*&text=${notCurrent}&select=couple_id,scope_key,text&limit=${limit}`),
      request(`notes?approved_at=is.null&text=${notCurrent}&text=not.is.null&select=id,author_user_id,text&limit=${limit}`),
      request(`drafts?or=(original.${notCurrent},reformulated.${notCurrent},translations.${notCurrent})&select=id,user_id,original,reformulated,translations&limit=${limit}`),
      request(`processed_updates?payload=${notCurrent}&payload=not.is.null&select=update_id,payload&limit=${limit}`),
    ]);
    return { messages, summaries, notes, drafts, updates };
  },

  async rewriteCiphertext(table, match, patch) {
    const filter = Object.entries(match)
      .map(([k, v]) => `${k}=eq.${encodeURIComponent(v)}`)
      .join("&");
    await request(`${table}?${filter}`, { method: "PATCH", body: patch });
  },

  // Approved, non-revoked notes (R15): re-read on every call.
  async activeNotes(coupleId) {
    return request(
      `notes?couple_id=eq.${Number(coupleId)}&approved_at=not.is.null&revoked_at=is.null&text=not.is.null&select=id,author_user_id,text&order=id.asc`,
    );
  },
};

// --- Couple state (R6, R12, R25, DR19) ---

// Atomic transition. { ok, from, to, changed, stateVersion } or
// { ok: false, reason, state }, e.g. reason = "not_pauser" (DR19).
export async function coupleTransition(coupleId, event, actorUserId = null) {
  const r = await rpc("couple_transition", { p_couple_id: coupleId, p_event: event, p_actor: actorUserId });
  if (!r.ok) return { ok: false, reason: r.reason, state: r.state };
  return { ok: true, from: r.from, to: r.to, changed: r.changed, stateVersion: r.state_version };
}

// --- Outgoing messages (R13, R27, R29) ---

// Claims an idempotency key. { claimed: true, id } means the row is ours and we may
// send; { claimed: false, status, tgMessageId } means the key is already taken.
// The message text isn't stored in the outbox: it's needed neither for dedup nor
// for a retry (there's no retry after an unknown outcome), and private chat text
// outside messages is exactly what R27 forbids.
export async function outboundClaim({ idempotencyKey, coupleId, scope, chatId, windowId, leaseId, part = 0 }) {
  const inserted = await request("outbound?on_conflict=idempotency_key", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
    body: {
      idempotency_key: idempotencyKey,
      couple_id: coupleId ?? null,
      scope,
      chat_id: chatId,
      window_id: windowId ?? null,
      lease_id: leaseId ?? null,
      part,
    },
  });
  if (inserted.length > 0) return { claimed: true, id: inserted[0].id };

  const [row] = await request(
    `outbound?idempotency_key=eq.${encodeURIComponent(idempotencyKey)}&select=status,tg_message_id`,
  );
  return { claimed: false, status: row?.status ?? "pending", tgMessageId: row?.tg_message_id ?? null };
}

// Key status without trying to claim it: sent | unknown | pending | null.
export async function outboundStatus(idempotencyKey) {
  const [row] = await request(`outbound?idempotency_key=eq.${encodeURIComponent(idempotencyKey)}&select=status`);
  return row?.status ?? null;
}

export async function outboundMarkSent(id, tgMessageId) {
  await request(`outbound?id=eq.${Number(id)}`, {
    method: "PATCH",
    body: { status: "sent", tg_message_id: tgMessageId ?? null, sent_at: new Date().toISOString() },
  });
}

export async function outboundMarkUnknown(id) {
  await request(`outbound?id=eq.${Number(id)}`, { method: "PATCH", body: { status: "unknown" } });
}

// Certainly not sent: release the key so the next attempt can send.
export async function outboundRelease(id) {
  await request(`outbound?id=eq.${Number(id)}`, { method: "DELETE" });
}

// --- Drafts: status transitions (R13) ---

// editing → sending with a conditional UPDATE. false means the draft is already
// being sent (double click, repeated callback) or doesn't exist.
export async function draftLockForSending(draftId, userId) {
  const rows = await request(`drafts?id=eq.${Number(draftId)}&user_id=eq.${Number(userId)}&status=eq.editing`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: { status: "sending" },
  });
  return rows.length === 1;
}

export async function draftSetStatus(draftId, status) {
  await request(`drafts?id=eq.${Number(draftId)}`, { method: "PATCH", body: { status } });
}

// After sending, the draft is deleted entirely (DR22 / section "Retention").
export async function draftDelete(draftId) {
  await request(`drafts?id=eq.${Number(draftId)}`, { method: "DELETE" });
}

// --- Windows and group messages (DR9, R21, R22) ---

// { messageId, windowId, closedWindowId, duplicate }
export async function ingestGroupMessage({
  coupleId,
  authorUserId,
  tgChatId,
  tgMessageId,
  text,
  kind = "text",
  lang = null,
  addressesBot = false,
}) {
  const r = await rpc("ingest_group_message", {
    p_couple_id: coupleId,
    p_author: authorUserId,
    p_tg_chat_id: tgChatId,
    p_tg_message_id: tgMessageId,
    p_text: text ?? null,
    p_kind: kind,
    p_lang: lang,
    p_addresses_bot: addressesBot,
  });
  return {
    messageId: Number(r.message_id),
    windowId: Number(r.window_id),
    closedWindowId: r.closed_window_id === null ? null : Number(r.closed_window_id),
    duplicate: r.duplicate,
  };
}

export async function markFirstReply(windowId) {
  await rpc("mark_first_reply", { p_window_id: windowId });
}

// --- Debounce (R1, R11) ---

// { answeredUpTo, latestId, firstUnansweredId, ended }, or null if there's no window.
export async function debounceState(windowId) {
  const state = await rpc("debounce_state", { p_window_id: windowId });
  if (!state) return null;
  return {
    answeredUpTo: Number(state.answered_up_to),
    latestId: state.latest_id === null ? null : Number(state.latest_id),
    firstUnansweredId: state.first_unanswered_id === null ? null : Number(state.first_unanswered_id),
    ended: state.ended,
    checkActive: Boolean(state.check_active),
    pendingTranscripts: Number(state.pending_transcripts ?? 0),
    latestAt: state.latest_at ? new Date(state.latest_at).getTime() : null,
  };
}

// --- Voice transcription (R22, R26) ---

export async function expireTranscripts(coupleId, seconds = 120) {
  return rpc("expire_transcripts", { p_couple_id: coupleId, p_seconds: seconds });
}

// { applied, late }: late = true means the result came after failed; don't wake the helper.
export async function setTranscript(messageId, text, lang = null) {
  return rpc("set_transcript", { p_message_id: messageId, p_text: text, p_lang: lang });
}

export async function windowCouple(windowId) {
  const [row] = await request(`windows?id=eq.${Number(windowId)}&select=couple_id`);
  return row ? Number(row.couple_id) : null;
}

// --- /check (R14, R16, DR6) ---

// { ok: true, id } | { ok: false, reason: "active" | "cooldown", retryInMinutes }
export async function checkStart(coupleId, speaker, listener, blockFrom, blockTo) {
  const r = await rpc("check_start", {
    p_couple_id: coupleId,
    p_speaker: speaker,
    p_listener: listener,
    p_block_from: blockFrom,
    p_block_to: blockTo,
  });
  if (r.ok) return { ok: true, id: Number(r.id) };
  return { ok: false, reason: r.reason, retryInMinutes: r.retry_in_minutes ?? null };
}

const CHECK_COLUMNS =
  "id,couple_id,speaker_user_id,listener_user_id,block_from,block_to,state,round,prompt_message_id,hinted,started_at,updated_at";

export async function checkActive(coupleId) {
  const [row] = await request(`checks?couple_id=eq.${Number(coupleId)}&ended_at=is.null&select=${CHECK_COLUMNS}`);
  return row ?? null;
}

// Conditional transition: applies only if (state, round) haven't changed.
// false means the button is stale or was already pressed.
export async function checkAdvance(id, from, patch) {
  const body = { ...patch, updated_at: new Date().toISOString() };
  if (patch.ended) {
    delete body.ended;
    body.ended_at = new Date().toISOString();
  }
  const rows = await request(
    `checks?id=eq.${Number(id)}&ended_at=is.null&state=eq.${encodeURIComponent(from.state)}&round=eq.${Number(from.round)}`,
    { method: "PATCH", headers: { Prefer: "return=representation" }, body },
  );
  return rows.length === 1;
}

export async function checkSetPrompt(id, promptMessageId) {
  await request(`checks?id=eq.${Number(id)}&ended_at=is.null`, {
    method: "PATCH",
    body: { prompt_message_id: promptMessageId },
  });
}

// --- Reply window lease (R2, R11, R12) ---

// Returns lease_id, or null if the window is taken or the marker already moved.
export async function claimReplyWindow(windowId, expectedMarker, leaseSeconds = 90) {
  return rpc("claim_reply_window", {
    p_window_id: windowId,
    p_expected_marker: expectedMarker,
    p_lease_seconds: leaseSeconds,
  });
}

export async function canPublish(windowId, leaseId, stateVersion) {
  return rpc("can_publish", { p_window_id: windowId, p_lease_id: leaseId, p_state_version: stateVersion });
}

// { ok, newerMessageId }: ok = false means the lease is no longer ours; do nothing.
export async function finishReply(windowId, leaseId, newMarker) {
  const result = await rpc("finish_reply", { p_window_id: windowId, p_lease_id: leaseId, p_new_marker: newMarker });
  return { ok: result.ok, newerMessageId: result.newer_message_id };
}

// --- Drafts and notes (DR10, DR11): for lib/draft.js only ---
//
// Data boundary: like contextReads, this object is imported only by
// lib/draft.js (static test test/unit/boundary.test.js).

export const draftReads = {
  async openDraft(userId) {
    const [row] = await request(
      `drafts?user_id=eq.${Number(userId)}&status=in.(awaiting_text,awaiting_edit,editing)&select=id,couple_id,user_id,original,reformulated,translations,status&order=id.desc&limit=1`,
    );
    return row ?? null;
  },
  async draft(draftId, userId) {
    const [row] = await request(
      `drafts?id=eq.${Number(draftId)}&user_id=eq.${Number(userId)}&select=id,couple_id,user_id,original,reformulated,translations,status`,
    );
    return row ?? null;
  },
  async createDraft({ coupleId, userId, original, status }) {
    // One open draft per person: older unfinished ones are deleted.
    await request(`drafts?user_id=eq.${Number(userId)}&status=in.(awaiting_text,awaiting_edit,editing)`, { method: "DELETE" });
    const [row] = await request("drafts", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: { couple_id: coupleId, user_id: userId, original: original ?? null, status },
    });
    return Number(row.id);
  },
  async updateDraft(draftId, patch) {
    await request(`drafts?id=eq.${Number(draftId)}`, { method: "PATCH", body: patch });
  },
  async deleteDraft(draftId, userId) {
    await request(`drafts?id=eq.${Number(draftId)}&user_id=eq.${Number(userId)}`, { method: "DELETE" });
  },

  async createNote({ coupleId, authorUserId, text }) {
    const [row] = await request("notes", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: { couple_id: coupleId, author_user_id: authorUserId, text },
    });
    return Number(row.id);
  },
  async note(noteId, authorUserId) {
    const [row] = await request(
      `notes?id=eq.${Number(noteId)}&author_user_id=eq.${Number(authorUserId)}&select=id,couple_id,text,approved_at,revoked_at,awaiting_edit`,
    );
    return row ?? null;
  },
  async noteAwaitingEdit(authorUserId) {
    const [row] = await request(
      `notes?author_user_id=eq.${Number(authorUserId)}&awaiting_edit=is.true&approved_at=is.null&select=id,couple_id,text&limit=1`,
    );
    return row ?? null;
  },
  async updateNote(noteId, patch) {
    await request(`notes?id=eq.${Number(noteId)}`, { method: "PATCH", body: patch });
  },
  async deleteNote(noteId, authorUserId) {
    await request(`notes?id=eq.${Number(noteId)}&author_user_id=eq.${Number(authorUserId)}`, { method: "DELETE" });
  },
  async activeNotesOf(authorUserId) {
    return request(
      `notes?author_user_id=eq.${Number(authorUserId)}&approved_at=not.is.null&revoked_at=is.null&text=not.is.null&select=id,text&order=id.asc`,
    );
  },
};

// --- Summaries and maintenance (DR9, DR22, R24, R30) ---

export async function windowInfo(windowId) {
  const r = await rpc("window_info", { p_window_id: windowId });
  if (!r) return null;
  return {
    coupleId: Number(r.couple_id),
    startedAt: r.started_at,
    endedAt: r.ended_at,
    firstReplyAt: r.first_reply_at,
  };
}

export async function upsertSummary(coupleId, scopeKey, text, coversUpTo) {
  return rpc("upsert_summary", { p_couple_id: coupleId, p_scope_key: scopeKey, p_text: text, p_covers_up_to: coversUpTo });
}

export async function cronPurge() {
  return rpc("cron_purge", {});
}

export async function dmFoldCandidates() {
  const rows = await rpc("dm_fold_candidates", {});
  return rows.map((r) => ({ coupleId: Number(r.couple_id), ownerUserId: Number(r.owner_user_id) }));
}

export async function groupFoldCandidates() {
  const rows = await rpc("group_fold_candidates", {});
  return rows.map((r) => Number(r.couple_id));
}

export async function deleteCoveredDm(coupleId, ownerUserId, coversUpTo) {
  return rpc("delete_covered_dm", { p_couple_id: coupleId, p_owner: ownerUserId, p_covers_up_to: coversUpTo });
}

// Updates stuck in the fallback with ciphertext: cron finishes them (R10).
export async function stuckUpdates(olderThanMinutes = 10) {
  const since = new Date(Date.now() - olderThanMinutes * 60_000).toISOString();
  return request(`processed_updates?status=eq.received&payload=not.is.null&received_at=lt.${since}&select=update_id,payload&limit=50`);
}

// Members' countries that need help-line numbers (T19).
export async function countriesInUse() {
  const rows = await request("members?country=not.is.null&select=country");
  return [...new Set(rows.map((r) => r.country))];
}
