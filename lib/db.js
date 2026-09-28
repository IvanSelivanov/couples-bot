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
  };
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
