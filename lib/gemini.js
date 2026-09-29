// The only module that talks to Gemini (R5). Everyone else passes in just the
// call's purpose, the prompt parts and the response schema; the wrapper rules
// live here, in one place:
//   - the call's quota tier and the atomic counter in Supabase (R20, R31);
//   - retries: network and 5xx once; per-minute 429 once after
//     Retry-After; unparseable JSON once;
//   - classifying filter blocks: crisis or neutral (section "Safety");
//   - logs without text: purpose, status, attempt number.
//
// The result is exactly one of three shapes:
//   { ok: true, data, usage }            usage is the share of the daily quota after the call
//   { blocked: "crisis" | "neutral" }
//   { unavailable: "quota" | "error", reason }

import { quotaTake } from "./db.js";

const MODEL = process.env.GEMINI_MODEL ?? "gemini-3.1-flash-lite";
const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

// The tier up to which a call is allowed (share of the daily limit, %).
// The crisis branch needs no model and isn't in the table.
export const PURPOSE_CUTOFF = {
  fold: 70, // folding summaries
  pause: 90, // pause call in the group: translations, safety, the helper's reply
  mention: 90, // reply to an @mention outside a pause
  guest: 90, // Guest Mode
  recap: 90, // recap of a closed window
  check_paraphrase: 90, // translating the paraphrase in /check
  transcribe_group: 90,
  dm_reply: 100,
  draft: 100,
  transcribe_dm: 100,
  copy_translate: 100, // translating fixed texts during onboarding (DR15)
  help_lines: 100, // looking up help-line numbers during onboarding and in cron (DR21), never during a crisis
};

// Voice summaries turn off at 70% (R20), while transcription itself runs up to 90%.
export const VOICE_SUMMARY_CUTOFF = 70;

// The model must see heavy content and return a safety flag, not stay silent.
const SAFETY_SETTINGS = [
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_DANGEROUS_CONTENT",
].map((category) => ({ category, threshold: "BLOCK_NONE" }));

// Categories whose block means a crisis: self-harm and threats go here.
// Everything else (sexual content, PROHIBITED_CONTENT, BLOCKLIST, SPII, OTHER)
// gets a neutral fallback: an emergency number in reply to an intimate
// conversation would be a false alarm.
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

// Retry-After from the header (seconds) or from Google's response body (RetryInfo).
function retryDelayMs(response, raw) {
  const header = Number(response.headers.get("retry-after"));
  if (Number.isFinite(header) && header > 0) return header * 1000;
  try {
    const details = JSON.parse(raw)?.error?.details ?? [];
    const info = details.find((d) => String(d["@type"]).endsWith("RetryInfo"));
    const seconds = parseFloat(info?.retryDelay);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  } catch {
    // the body isn't JSON: use the default
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
 * @param {Array<object>} request.parts content parts (text / inline_data)
 * @param {object} [request.schema] responseSchema; without it the response is a string
 * @param {string} [request.system] systemInstruction
 * @param {string} [request.mediaResolution] for video notes: MEDIA_RESOLUTION_LOW
 * @param {number} [request.timeoutMs] timeout of a single attempt
 * @param {AbortSignal} [request.deadline] overall processing budget
 * @param {string} [request.apiKey] evals only: a separate key (evals must not spend the couple's quota)
 * @param {boolean} [request.skipQuota] evals only: no quota counter in Supabase
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

    // Every attempt is a separate request for Gemini's quota, so it goes into the counter too.
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
        // falls through to the parse retry below
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

// Overall processing budget: an AbortSignal plus the end time, to decide
// whether a retry after 429 still fits.
export function deadlineIn(ms) {
  const signal = AbortSignal.timeout(ms);
  signal.deadlineAt = Date.now() + ms;
  return signal;
}
