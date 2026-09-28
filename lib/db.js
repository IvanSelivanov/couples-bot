// Доступ к Supabase через PostgREST на глобальном fetch, без SDK.
//
// Граница данных (дизайн-док, «Граница в коде»): этот модуль не экспортирует
// сырые чтения messages, notes, summaries и drafts. Их читают только
// lib/context.js и lib/draft.js через отдельные функции, которые появятся там.

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
    // Тело ошибки PostgREST описывает SQL-проблему и не содержит данных строк.
    throw new DbError(`${method} ${path.split("?")[0]}: HTTP ${response.status} ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;
}

export async function rpc(name, args) {
  return request(`rpc/${name}`, { method: "POST", body: args });
}

// --- Приём апдейтов (R3, R10, R19, R27) ---

// Бюджет операций Vercel Queues за месяц (R1). true — можно слать в очередь.
export async function queueBudgetTake(ops, monthlyLimit, cutoffPct) {
  return rpc("queue_budget_take", { p_ops: ops, p_monthly_limit: monthlyLimit, p_cutoff_pct: cutoffPct });
}

// Записывает приём апдейта. Возвращает статус строки после вставки:
// "received" — новая или ещё не обработанная, "done" — уже обработан.
// payload (шифротекст) пишется только в фолбэке без очереди.
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

// Готово: статус done, payload стирается (R27).
export async function markDone(updateId) {
  await request(`processed_updates?update_id=eq.${Number(updateId)}`, {
    method: "PATCH",
    body: { status: "done", payload: null },
  });
}

// --- Квота Gemini (R20, R31) ---

// { allowed, used }: allowed = false — уровень вызова уже исчерпан.
export async function quotaTake(dailyLimit, cutoffPct) {
  return rpc("quota_take", { p_daily_limit: dailyLimit, p_cutoff_pct: cutoffPct });
}

// --- Абьюз-флаги (DR20) ---

// Новый сигнал добавляет строку, а не перезаписывает старую (дизайн-док).
export async function addAbuseFlag(coupleId, source) {
  await request("abuse_flags", { method: "POST", body: { couple_id: coupleId, source } });
}

// --- Номера помощи по странам (DR21) ---

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

// Страны, чей кеш устарел или не собрался, — для ежемесячного cron.
export async function helpLinesStale(olderThanDays) {
  const since = new Date(Date.now() - olderThanDays * 24 * 3600 * 1000).toISOString();
  const rows = await request(`help_lines?or=(fetched_at.lt.${since},status.eq.failed)&select=country`);
  return rows.map((r) => r.country);
}

export async function coupleCountries(coupleId) {
  const rows = await request(`members?couple_id=eq.${Number(coupleId)}&country=not.is.null&select=country`);
  return [...new Set(rows.map((r) => r.country))];
}

// --- Кеш переводов фиксированных текстов (DR15, R23, TD1) ---

export async function copyCacheGet(lang, key) {
  const [row] = await request(
    `copy_cache?lang=eq.${encodeURIComponent(lang)}&key=eq.${encodeURIComponent(key)}&select=text,source_hash,reviewed,stale`,
  );
  return row ?? null;
}

// Новый машинный перевод. Если ключ был вычитан человеком, а исходник
// изменился, строка помечается stale: вычитку нужно повторить (R23).
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

// --- Сырые чтения для контекста (граница данных) ---
//
// Только lib/context.js и lib/draft.js могут импортировать contextReads —
// это проверяет статический тест test/unit/boundary.test.js. Каждая функция
// читает узко: границу скоупа задаёт запрос, а не фильтр после чтения.

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

  // Общая история: group и guest вместе, последние limit, по возрастанию id.
  async sharedMessages(coupleId, limit) {
    const rows = await request(
      `messages?couple_id=eq.${Number(coupleId)}&scope=in.(group,guest)&select=${MESSAGE_COLUMNS}&order=id.desc&limit=${Number(limit)}`,
    );
    return rows.reverse();
  },

  // Личка ровно одного владельца.
  async dmMessages(coupleId, ownerUserId, limit) {
    const rows = await request(
      `messages?couple_id=eq.${Number(coupleId)}&scope=eq.dm&owner_user_id=eq.${Number(ownerUserId)}&select=${MESSAGE_COLUMNS}&order=id.desc&limit=${Number(limit)}`,
    );
    return rows.reverse();
  },

  // Есть ли активный абьюз-флаг: при нём бот не «уравнивает стороны» и сам не
  // предлагает упражнения. Текста переписки во флаге нет.
  async abuseFlagActive(coupleId) {
    const rows = await request(`abuse_flags?couple_id=eq.${Number(coupleId)}&cleared_at=is.null&select=id&limit=1`);
    return rows.length > 0;
  },

  // Одобренные и не отозванные заметки (R15): читаются заново на каждый вызов.
  async activeNotes(coupleId) {
    return request(
      `notes?couple_id=eq.${Number(coupleId)}&approved_at=not.is.null&revoked_at=is.null&text=not.is.null&select=id,author_user_id,text&order=id.asc`,
    );
  },
};

// --- Состояние пары (R6, R12, R25, DR19) ---

// Атомарный переход. { ok, from, to, changed, stateVersion } или
// { ok: false, reason, state } — например reason = "not_pauser" (DR19).
export async function coupleTransition(coupleId, event, actorUserId = null) {
  const r = await rpc("couple_transition", { p_couple_id: coupleId, p_event: event, p_actor: actorUserId });
  if (!r.ok) return { ok: false, reason: r.reason, state: r.state };
  return { ok: true, from: r.from, to: r.to, changed: r.changed, stateVersion: r.state_version };
}

// --- Исходящие (R13, R27, R29) ---

// Занимает ключ идемпотентности. { claimed: true, id } — строка наша, можно
// отправлять; { claimed: false, status, tgMessageId } — ключ уже занят.
// Текст сообщения в outbox не хранится: он не нужен ни для дедупа, ни для
// повтора (после неизвестного исхода повтора нет), а текст лички вне
// messages — это ровно то, что запрещает R27.
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

// Статус ключа без попытки занять его: sent | unknown | pending | null.
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

// Точно не отправлено: освобождаем ключ, чтобы следующая попытка могла послать.
export async function outboundRelease(id) {
  await request(`outbound?id=eq.${Number(id)}`, { method: "DELETE" });
}

// --- Черновики: переходы статуса (R13) ---

// editing → sending условным UPDATE. false — черновик уже отправляется
// (двойной клик, повторный callback) или его нет.
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

// После отправки черновик удаляется целиком (DR22 / раздел «Хранение»).
export async function draftDelete(draftId) {
  await request(`drafts?id=eq.${Number(draftId)}`, { method: "DELETE" });
}

// --- Окна и реплики группы (DR9, R21, R22) ---

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

// --- Дебаунс (R1, R11) ---

// { answeredUpTo, latestId, firstUnansweredId, ended } или null, если окна нет.
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

// --- Расшифровка голосовых (R22, R26) ---

export async function expireTranscripts(coupleId, seconds = 120) {
  return rpc("expire_transcripts", { p_couple_id: coupleId, p_seconds: seconds });
}

// { applied, late }: late = true — результат после failed, ведущего не будить.
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

// Условный переход: применяется, только если (state, round) не изменились.
// false — кнопка устарела или её уже нажали.
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

// --- Аренда окна ответа (R2, R11, R12) ---

// Возвращает lease_id или null, если окно занято или маркер уже сдвинут.
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

// { ok, newerMessageId }: ok = false — аренда уже не наша, ничего не делать.
export async function finishReply(windowId, leaseId, newMarker) {
  const result = await rpc("finish_reply", { p_window_id: windowId, p_lease_id: leaseId, p_new_marker: newMarker });
  return { ok: result.ok, newerMessageId: result.newer_message_id };
}
