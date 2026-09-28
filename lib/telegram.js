// Тонкая обёртка над Bot API. Только глобальный fetch, без зависимостей.

const API_BASE = "https://api.telegram.org";

// getFile отдаёт файлы не больше 20 МБ. Лимит платформы, снимается только
// собственным Local Bot API Server.
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

// Лимиты Bot API: 4096 — текст сообщения, 1024 — подпись к документу.
export const MAX_MESSAGE_CHARS = 4096;
export const MAX_CAPTION_CHARS = 1024;

export class TelegramError extends Error {}

function token() {
  const value = process.env.BOT_TOKEN;
  if (!value) throw new TelegramError("BOT_TOKEN не задан");
  return value;
}

// Сетевые сбои Telegram бывают разовыми: 2026-08-01 getFile завис и отвалился
// по таймауту, а повтор того же сообщения через минуту прошёл без проблем.
// Поэтому короткий таймаут плюс ретраи, а не одно долгое ожидание:
// getFile отвечает за доли секунды, ждать его минуту бессмысленно.
// 3 повтора = 4 попытки всего. Худший случай для getFile: 4×15 с ожидания
// плюс 0.7+1.4+2.8 с пауз ≈ 65 с. Укладывается в maxDuration 300 с с запасом,
// и это допустимо только потому, что мы в фоне через waitUntil — Telegram
// ответ уже получил и нас не ждёт.
const RETRIES = 3;

// Экспоненциальная, а не линейная: если сервис прилёг, частые повторы
// мешают ему встать.
const RETRY_BACKOFF_MS = 700;

function isTransient(error) {
  return (
    error.name === "TimeoutError" ||
    error.name === "AbortError" ||
    error instanceof TypeError // fetch кидает TypeError на сетевых сбоях
  );
}

export class BudgetExhausted extends TelegramError {}

// deadline — общий AbortSignal на всю обработку голосовухи. Без него сумма
// таймаутов трёх звеньев (getFile + download + Gemini) с ретраями переваливает
// за maxDuration, функцию прибивают на середине, и пользователь не получает
// ничего: ни текста, ни ошибки. Поэтому каждый запрос ограничен минимумом из
// своего таймаута и остатка общего бюджета.
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

      // Общий бюджет кончился — повторять бессмысленно, времени всё равно нет.
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

// label — то, что увидит пользователь, если всё сорвётся. Поэтому
// по-русски и про суть, а не имя метода Bot API.
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

export async function sendMessage(chatId, text, { parseMode, replyTo } = {}) {
  const params = { chat_id: chatId, text };
  if (parseMode) params.parse_mode = parseMode;
  if (replyTo) params.reply_parameters = { message_id: replyTo };
  return call("sendMessage", params);
}

// Живёт около пяти секунд, поэтому на долгих операциях переотправляется —
// этим занимается withTyping в lib/handle.js.
export async function sendChatAction(chatId, action = "typing") {
  return call("sendChatAction", { chat_id: chatId, action });
}

export async function sendDocument(chatId, filename, content, { caption, replyTo } = {}) {
  const form = new FormData();
  form.set("chat_id", String(chatId));
  form.set("document", new Blob([content], { type: "text/plain" }), filename);
  if (caption) form.set("caption", caption);
  if (replyTo) form.set("reply_parameters", JSON.stringify({ message_id: replyTo }));

  const response = await fetchWithRetry(
    "sendDocument",
    `${API_BASE}/bot${token()}/sendDocument`,
    { method: "POST", body: form },
    30_000,
  );

  const payload = await response.json();
  if (!payload.ok) {
    throw new TelegramError(`sendDocument: ${payload.description ?? response.status}`);
  }
  return payload.result;
}

// Экранирование для parse_mode=HTML. Три замены, библиотека не нужна.
export function escapeHtml(text) {
  return String(text ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
