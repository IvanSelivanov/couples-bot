// Thin wrapper over the Bot API. Global fetch only, no dependencies.
//
// Two retry policies:
//   call — reads and idempotent methods (getFile, getChatMember, getUpdates):
//          retried on timeout too, as in tgbot;
//   send — sending messages: retried only when it certainly wasn't sent (R13).

const API_BASE = "https://api.telegram.org";

// getFile serves files up to 20 MB. A platform limit, lifted only by running
// your own Local Bot API Server.
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

// Bot API limits: 4096 for message text, 1024 for a document caption.
export const MAX_MESSAGE_CHARS = 4096;
export const MAX_CAPTION_CHARS = 1024;

export class TelegramError extends Error {}

function token() {
  const value = process.env.BOT_TOKEN;
  if (!value) throw new TelegramError("BOT_TOKEN не задан");
  return value;
}

// Telegram network failures are often one-offs: on 2026-08-01 getFile hung and
// timed out, and retrying the same message a minute later went through fine.
// Hence a short timeout plus retries rather than one long wait:
// getFile answers in a fraction of a second, waiting a minute for it is pointless.
// 3 retries = 4 attempts in total. Worst case for getFile: 4×15 s of waiting
// plus 0.7+1.4+2.8 s of pauses ≈ 65 s. Fits in maxDuration 300 s with room to
// spare, and that's acceptable only because we run in the background: Telegram
// already got its response and isn't waiting for us.
const RETRIES = 3;

// Exponential, not linear: if the service is down, frequent retries keep it
// from getting back up.
const RETRY_BACKOFF_MS = 700;

function isTransient(error) {
  return (
    error.name === "TimeoutError" ||
    error.name === "AbortError" ||
    error instanceof TypeError // fetch throws TypeError on network failures
  );
}

export class BudgetExhausted extends TelegramError {}

// deadline is a shared AbortSignal for all of the voice message processing. Without
// it the sum of timeouts of three links (getFile + download + Gemini) with retries
// exceeds maxDuration, the function gets killed midway and the user receives
// nothing: no text, no error. So each request is bounded by the minimum of its
// own timeout and what's left of the overall budget.
async function fetchWithRetry(what, url, options, timeoutMs, deadline) {
  let lastError;

  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (deadline?.aborted) {
      throw new BudgetExhausted(`${what}: не уложились в общий лимит времени`);
    }

    const perCall = AbortSignal.timeout(timeoutMs);
    const signal = deadline ? AbortSignal.any([perCall, deadline]) : perCall;

    try {
      return await fetch(url, { ...options, signal });
    } catch (error) {
      lastError = error;

      // The overall budget is spent: retrying is pointless, there's no time anyway.
      if (deadline?.aborted) {
        throw new BudgetExhausted(`${what}: не уложились в общий лимит времени`);
      }
      if (!isTransient(error) || attempt === RETRIES) break;

      console.warn(`[telegram] ${what}: ${error.name}, попытка ${attempt + 2} из ${RETRIES + 1}`);
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * 2 ** attempt));
    }
  }

  if (lastError?.name === "TimeoutError" || lastError?.name === "AbortError") {
    throw new TelegramError(`${what}: Telegram не ответил за ${timeoutMs / 1000} с (${RETRIES + 1} попытки)`);
  }
  throw new TelegramError(`${what}: ${lastError?.message ?? "неизвестная сетевая ошибка"}`);
}

// label is what the user sees if everything fails, so it describes what
// happened in plain words rather than naming the Bot API method.
export async function call(method, params, { timeoutMs = 15_000, label = method, deadline } = {}) {
  const response = await fetchWithRetry(
    label,
    `${API_BASE}/bot${token()}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    },
    timeoutMs,
    deadline,
  );

  const payload = await response.json();
  if (!payload.ok) {
    throw new TelegramError(`${method}: ${payload.description ?? response.status}`);
  }
  return payload.result;
}

export async function getFile(fileId, { deadline } = {}) {
  return call("getFile", { file_id: fileId }, { label: "не смог получить файл от Telegram", deadline });
}

export async function download(filePath, { deadline } = {}) {
  const response = await fetchWithRetry(
    "скачивание файла",
    `${API_BASE}/file/bot${token()}/${filePath}`,
    {},
    30_000,
    deadline,
  );

  if (!response.ok) {
    throw new TelegramError(`скачивание файла: HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

// --- Sending: not idempotent, its own retry policy (R13) ---
//
// Retrying a send after a timeout risks a duplicate: Telegram may have accepted
// the message and the response got lost. So we retry only when it was CERTAINLY
// not sent: an explicit Telegram answer (429 with retry_after, 5xx) or a failure
// to establish the connection (the request never left). A timeout or a drop after
// sending is OutcomeUnknown with no retry; the outbox decides what to do with it.

// The outcome of the send is unknown: the message may have gone out.
export class OutcomeUnknown extends TelegramError {}

const SEND_RETRIES = 2;
const MAX_RETRY_AFTER_MS = 30_000;

// undici codes for which the request certainly never reached Telegram.
const NOT_SENT_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

export function wasNotSent(error) {
  const code = error?.cause?.code ?? error?.code;
  return NOT_SENT_CODES.has(code);
}

async function postOnce(method, body, { timeoutMs, headers }) {
  return fetch(`${API_BASE}/bot${token()}/${method}`, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/**
 * A sending Bot API method with the R13 policy.
 * @param {string} method sendMessage, sendDocument, answerGuestQuery, …
 * @param {object|FormData} params JSON parameters or FormData
 */
export async function send(method, params, { timeoutMs = 15_000 } = {}) {
  const isForm = params instanceof FormData;
  const body = isForm ? params : JSON.stringify(params);
  const headers = isForm ? undefined : { "Content-Type": "application/json" };

  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await postOnce(method, body, { timeoutMs, headers });
    } catch (error) {
      if (wasNotSent(error) && attempt < SEND_RETRIES) {
        console.warn(`[telegram] ${method}: соединение не установлено, попытка ${attempt + 2}`);
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * 2 ** attempt));
        continue;
      }
      if (wasNotSent(error)) throw new TelegramError(`${method}: соединение не установлено`);
      throw new OutcomeUnknown(`${method}: ${error.name}, исход неизвестен`);
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      // A response came but its body can't be read: Telegram may have accepted it.
      if (response.status >= 500 && attempt < SEND_RETRIES) continue;
      throw new OutcomeUnknown(`${method}: HTTP ${response.status}, тело не разобрано`);
    }
    if (payload.ok) return payload.result;

    if (response.status === 429 && attempt < SEND_RETRIES) {
      const waitMs = Math.min(MAX_RETRY_AFTER_MS, (payload.parameters?.retry_after ?? 1) * 1000);
      console.warn(`[telegram] ${method}: 429, повтор через ${waitMs / 1000} с`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    if (response.status >= 500 && attempt < SEND_RETRIES) {
      console.warn(`[telegram] ${method}: HTTP ${response.status}, попытка ${attempt + 2}`);
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * 2 ** attempt));
      continue;
    }
    // An explicit refusal from Telegram: certainly not sent.
    const error = new TelegramError(`${method}: ${payload.description ?? response.status}`);
    error.status = response.status;
    throw error;
  }
}

/**
 * Sending through the outbox (R13): at most one message per key.
 *
 *   key free ─▶ pending ─▶ send ─┬ ok ──────────▶ sent
 *                                ├ certainly not ─▶ key released, failed
 *                                └ unknown ─────▶ unknown (no retry)
 *   key taken ─▶ already_sent | already_unknown | in_flight, nothing is sent
 *
 * @param {object} message
 * @param {string} message.key idempotency key
 * @param {"group"|"guest"|"dm"} message.scope
 * @param {number} message.chatId
 * @param {string} message.method Bot API method
 * @param {object|FormData} message.params
 * @param {object} deps { store: outboundClaim/…, sendFn }
 */
export async function deliver(message, { store, sendFn = send }) {
  const claim = await store.outboundClaim({
    idempotencyKey: message.key,
    coupleId: message.coupleId,
    scope: message.scope,
    chatId: message.chatId,
    windowId: message.windowId,
    leaseId: message.leaseId,
    part: message.part ?? 0,
  });

  if (!claim.claimed) {
    // Someone else's pending row: another task is sending right now or died
    // mid-send. Either way we don't send: at-most-once.
    const status = { sent: "already_sent", unknown: "already_unknown" }[claim.status] ?? "in_flight";
    return { status, tgMessageId: claim.tgMessageId };
  }

  try {
    const result = await sendFn(message.method, message.params);
    await store.outboundMarkSent(claim.id, result?.message_id);
    return { status: "sent", tgMessageId: result?.message_id ?? null };
  } catch (error) {
    if (error instanceof OutcomeUnknown) {
      await store.outboundMarkUnknown(claim.id);
      return { status: "unknown", tgMessageId: null };
    }
    await store.outboundRelease(claim.id);
    return { status: "failed", error };
  }
}

export async function sendMessage(chatId, text, { parseMode, replyTo, disableNotification } = {}) {
  const params = { chat_id: chatId, text };
  if (parseMode) params.parse_mode = parseMode;
  if (replyTo) params.reply_parameters = { message_id: replyTo };
  if (disableNotification) params.disable_notification = true;
  return send("sendMessage", params);
}

// Lasts about five seconds, so long operations resend it;
// withTyping in lib/handle.js takes care of that.
export async function sendChatAction(chatId, action = "typing") {
  return call("sendChatAction", { chat_id: chatId, action });
}

export async function sendDocument(chatId, filename, content, { caption, replyTo } = {}) {
  const form = new FormData();
  form.set("chat_id", String(chatId));
  form.set("document", new Blob([content], { type: "text/plain" }), filename);
  if (caption) form.set("caption", caption);
  if (replyTo) form.set("reply_parameters", JSON.stringify({ message_id: replyTo }));
  return send("sendDocument", form, { timeoutMs: 30_000 });
}

// Escaping for parse_mode=HTML. Three replacements, no library needed.
export function escapeHtml(text) {
  return String(text ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
