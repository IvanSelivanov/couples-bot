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
// Сам ответ ведущего (вызов модели, публикация, finish_reply) — не здесь:
// respond приходит зависимостью. Хвост R11 возвращается из finish_reply и
// ставится через scheduleTail.

import * as db from "./db.js";
import { QUEUE_CUTOFF_PCT, QUEUE_MONTHLY_OPS, QUEUE_OPS_PER_MESSAGE } from "./ingest.js";

export const DEBOUNCE_TOPIC = "debounce";
export const DEBOUNCE_MS = Number(process.env.DEBOUNCE_MS ?? 20_000);
export const MAX_WAIT_MS = Number(process.env.MAX_WAIT_MS ?? 60_000);

/**
 * Чистое решение по сработавшей проверке.
 * @param {{answeredUpTo: number, latestId: number|null, ended?: boolean}} state
 * @param {{kind: "debounce"|"max_wait", messageId: number}} check
 * @returns {"answered"|"superseded"|"respond"}
 */
export function decide(state, check) {
  if (!state || state.ended || state.latestId === null) return "answered";

  if (check.kind === "max_wait") {
    // Блок, начатый этой репликой, уже покрыт — дальше отвечают свои проверки.
    return state.answeredUpTo >= check.messageId ? "answered" : "respond";
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

// Хвост R11: finish_reply сообщил о реплике, пришедшей во время генерации.
export async function scheduleTail(windowId, messageId, deps) {
  return schedule({ windowId, messageId, kind: "debounce" }, DEBOUNCE_MS, deps);
}

/**
 * Ответ ведущего после паузы: аренда → вызов паузы → публикация → finish_reply.
 * Пока каркас: вызов модели (R20), формат (R29) и outbox (T7) появятся в
 * следующих задачах. Сейчас только захват и освобождение аренды без сдвига
 * маркера, чтобы дебаунс проверялся от начала до конца.
 */
export async function respond(windowId, expectedMarker, { store = db } = {}) {
  const lease = await store.claimReplyWindow(windowId, expectedMarker);
  if (!lease) return { claimed: false };
  const result = await store.finishReply(windowId, lease, expectedMarker);
  return { claimed: true, ...result };
}

/**
 * Сработавшая проверка: из очереди или после сна.
 * @param {(windowId: number, expectedMarker: number) => Promise<unknown>} deps.respond
 * @returns {Promise<"answered"|"superseded"|"respond">}
 */
export async function runCheck(check, { respond, store = db }) {
  const state = await store.debounceState(check.windowId);
  const decision = decide(state, check);
  if (decision === "respond") await respond(check.windowId, state.answeredUpTo);
  return decision;
}
