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

// --- Квота Gemini (R20, R31) ---

// { allowed, used }: allowed = false — уровень вызова уже исчерпан.
export async function quotaTake(dailyLimit, cutoffPct) {
  return rpc("quota_take", { p_daily_limit: dailyLimit, p_cutoff_pct: cutoffPct });
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
