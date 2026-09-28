// Единственный модуль, который ходит в Gemini (R5). Остальные передают сюда
// только назначение вызова, части промпта и схему ответа, а правила
// обвязки живут здесь одним экземпляром:
//   - уровень квоты вызова и атомарный счётчик в Supabase (R20, R31);
//   - повторы: сеть и 5xx — один раз; минутный 429 — один раз через
//     Retry-After; непарсящийся JSON — один раз;
//   - разбор блокировок фильтром: crisis или neutral (раздел «Безопасность»);
//   - логи без текста: назначение, статус, номер попытки.
//
// Результат — ровно одна из трёх форм:
//   { ok: true, data, usage }            usage — доля дневной квоты после вызова
//   { blocked: "crisis" | "neutral" }
//   { unavailable: "quota" | "error", reason }

import { quotaTake } from "./db.js";

const MODEL = process.env.GEMINI_MODEL ?? "gemini-3.1-flash-lite";
const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

// Уровень, до которого вызов разрешён (доля дневного лимита, %).
// Кризисная ветка модели не требует и в таблицу не входит.
export const PURPOSE_CUTOFF = {
  fold: 70, // сворачивание сводок
  pause: 90, // вызов паузы в группе: переводы, безопасность, ответ ведущего
  mention: 90, // ответ на @ вне паузы
  guest: 90, // Guest Mode
  recap: 90, // итог закрытого окна
  check_paraphrase: 90, // перевод пересказа в /check
  transcribe_group: 90,
  dm_reply: 100,
  draft: 100,
  transcribe_dm: 100,
  copy_translate: 100, // перевод фиксированных текстов на онбординге (DR15)
  help_lines: 100, // поиск номеров помощи на онбординге и в cron (DR21), не в момент кризиса
};

// Саммари голосовых выключается на 70% (R20), хотя сама расшифровка идёт до 90%.
export const VOICE_SUMMARY_CUTOFF = 70;

// Модель должна видеть тяжёлый контент и возвращать флаг safety, а не молчать.
const SAFETY_SETTINGS = [
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_DANGEROUS_CONTENT",
].map((category) => ({ category, threshold: "BLOCK_NONE" }));

// Категории, чья блокировка означает кризис: сюда попадают самоповреждение
// и угрозы. Остальное (интим, PROHIBITED_CONTENT, BLOCKLIST, SPII, OTHER)
// даёт нейтральный фолбэк: экстренный номер в ответ на интимный разговор —
// ложная тревога.
const CRISIS_CATEGORIES = new Set(["HARM_CATEGORY_DANGEROUS_CONTENT", "HARM_CATEGORY_HARASSMENT"]);

const NETWORK_RETRIES = 1;
const PARSE_RETRIES = 1;
const RATE_LIMIT_RETRIES = 1;
const DEFAULT_RATE_LIMIT_WAIT_MS = 60_000;

function dailyLimit() {
  return Number(process.env.GEMINI_DAILY_LIMIT ?? 500);
}

function apiKey() {
  const value = process.env.GEMINI_API_KEY;
  if (!value) throw new Error("GEMINI_API_KEY не задан");
  return value;
}

function log(purpose, message) {
  console.warn(`[gemini] ${purpose}: ${message}`);
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

function remainingMs(deadlineAt) {
  return deadlineAt === undefined ? Infinity : deadlineAt - Date.now();
}

// Retry-After из заголовка (секунды) или из тела ответа Google (RetryInfo).
function retryDelayMs(response, raw) {
  const header = Number(response.headers.get("retry-after"));
  if (Number.isFinite(header) && header > 0) return header * 1000;
  try {
    const details = JSON.parse(raw)?.error?.details ?? [];
    const info = details.find((d) => String(d["@type"]).endsWith("RetryInfo"));
    const seconds = parseFloat(info?.retryDelay);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  } catch {
    // тело не JSON — берём значение по умолчанию
  }
  return DEFAULT_RATE_LIMIT_WAIT_MS;
}

export function classifyBlock(payload) {
  const candidate = payload?.candidates?.[0];
  const reason = payload?.promptFeedback?.blockReason ?? candidate?.finishReason;
  if (reason !== "SAFETY") return "neutral";

  const ratings = [...(payload?.promptFeedback?.safetyRatings ?? []), ...(candidate?.safetyRatings ?? [])];
  const blocked = ratings.filter((r) => r.blocked);
  const suspects = blocked.length > 0 ? blocked : ratings.filter((r) => r.probability === "HIGH");
  return suspects.some((r) => CRISIS_CATEGORIES.has(r.category)) ? "crisis" : "neutral";
}

function isBlocked(payload) {
  if (payload?.promptFeedback?.blockReason) return true;
  const finish = payload?.candidates?.[0]?.finishReason;
  return ["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION"].includes(finish);
}

/**
 * @param {object} request
 * @param {keyof PURPOSE_CUTOFF} request.purpose
 * @param {Array<object>} request.parts части контента (text / inline_data)
 * @param {object} [request.schema] responseSchema; без неё ответ — строка
 * @param {string} [request.system] systemInstruction
 * @param {string} [request.mediaResolution] для кружков: MEDIA_RESOLUTION_LOW
 * @param {number} [request.timeoutMs] таймаут одной попытки
 * @param {AbortSignal} [request.deadline] общий бюджет обработки
 * @param {string} [request.apiKey] только евалы: отдельный ключ (дизайн-док — евалы не тратят квоту пары)
 * @param {boolean} [request.skipQuota] только евалы: без счётчика квоты в Supabase
 */
export async function generate({ purpose, parts, schema, system, mediaResolution, timeoutMs = 60_000, deadline, apiKey: keyOverride, skipQuota = false }) {
  const cutoff = PURPOSE_CUTOFF[purpose];
  if (cutoff === undefined) throw new Error(`неизвестное назначение вызова: ${purpose}`);

  const deadlineAt = deadline?.deadlineAt;
  const body = {
    contents: [{ role: "user", parts }],
    safetySettings: SAFETY_SETTINGS,
    generationConfig: {
      ...(schema ? { responseMimeType: "application/json", responseSchema: schema } : {}),
      ...(mediaResolution ? { mediaResolution } : {}),
    },
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
  };

  let networkRetries = NETWORK_RETRIES;
  let parseRetries = PARSE_RETRIES;
  let rateLimitRetries = RATE_LIMIT_RETRIES;
  let usage = 0;

  for (let attempt = 1; ; attempt++) {
    if (deadline?.aborted) return { unavailable: "error", reason: "deadline" };

    // Каждая попытка — отдельный запрос для квоты Gemini, поэтому и в счётчик.
    if (!skipQuota) {
      const quota = await quotaTake(dailyLimit(), cutoff);
      if (!quota.allowed) {
        log(purpose, `уровень ${cutoff}% исчерпан`);
        return { unavailable: "quota", reason: "level" };
      }
      usage = quota.used / dailyLimit();
    }

    let response;
    try {
      const perCall = AbortSignal.timeout(timeoutMs);
      response = await fetch(`${ENDPOINT}/${MODEL}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": keyOverride ?? apiKey() },
        body: JSON.stringify(body),
        signal: deadline ? AbortSignal.any([perCall, deadline]) : perCall,
      });
    } catch (error) {
      if (deadline?.aborted) return { unavailable: "error", reason: "deadline" };
      if (networkRetries-- > 0) {
        log(purpose, `${error.name}, попытка ${attempt + 1}`);
        continue;
      }
      log(purpose, `сеть: ${error.name}`);
      return { unavailable: "error", reason: "network" };
    }

    const raw = await response.text();

    if (response.status === 429) {
      const waitMs = retryDelayMs(response, raw);
      if (rateLimitRetries-- > 0 && waitMs < remainingMs(deadlineAt)) {
        log(purpose, `429, повтор через ${Math.round(waitMs / 1000)} с`);
        try {
          await sleep(waitMs, deadline);
        } catch {
          return { unavailable: "error", reason: "deadline" };
        }
        continue;
      }
      log(purpose, "429, квота Gemini исчерпана");
      return { unavailable: "quota", reason: "429" };
    }

    if (response.status >= 500) {
      if (networkRetries-- > 0) {
        log(purpose, `HTTP ${response.status}, попытка ${attempt + 1}`);
        continue;
      }
      log(purpose, `HTTP ${response.status}`);
      return { unavailable: "error", reason: `http_${response.status}` };
    }

    if (!response.ok) {
      log(purpose, `HTTP ${response.status}`);
      return { unavailable: "error", reason: `http_${response.status}` };
    }

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      log(purpose, "тело ответа не JSON");
      return { unavailable: "error", reason: "body" };
    }

    if (isBlocked(payload)) {
      const kind = classifyBlock(payload);
      log(purpose, `блокировка фильтром → ${kind}`);
      return { blocked: kind };
    }

    const text = payload?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";

    if (!schema) {
      if (text.trim()) return { ok: true, data: text.trim(), usage };
    } else {
      try {
        const data = JSON.parse(text);
        if (data && typeof data === "object") return { ok: true, data, usage };
      } catch {
        // упадёт в parse-retry ниже
      }
    }

    if (parseRetries-- > 0) {
      log(purpose, `ответ не разобран, попытка ${attempt + 1}`);
      continue;
    }
    log(purpose, "ответ не разобран дважды");
    return { unavailable: "error", reason: "parse" };
  }
}

// Общий бюджет обработки: AbortSignal плюс момент окончания, чтобы решать,
// успеет ли повтор после 429.
export function deadlineIn(ms) {
  const signal = AbortSignal.timeout(ms);
  signal.deadlineAt = Date.now() + ms;
  return signal;
}
