// Durable intake of an update before answering Telegram (R10, R19, R1, R27).
//
// In tgbot the webhook answered 200 right away and worked in waitUntil: if the
// instance died mid-work, the update was lost and Telegram didn't resend it.
// Here 200 is sent only once the update is stored somewhere:
//
//   update ─▶ Queues budget < 90%? ─ yes ─▶ send to queue ─ ok ─▶ 200
//                  │ no / error              │ error
//                  ▼                         ▼
//             fallback: processed_updates = received + ciphertext ─ ok ─▶ process in defer, 200
//                                                                 └ error ─▶ 503, Telegram retries
//
// Processing (processUpdate) is the same for the queue, the fallback and local
// polling: a duplicate is skipped only after done (R3, R10), then the payload is
// wiped (R27). The update itself is stored as ciphertext in the queue and in the
// fallback: it may contain a private chat (R27).

import * as db from "./db.js";
import { decrypt, encrypt } from "./crypto.js";

export const UPDATES_TOPIC = "updates";

// Vercel Queues budget (R1): 1,000,000 operations a month on Hobby, ~3 per message.
export const QUEUE_MONTHLY_OPS = 1_000_000;
export const QUEUE_OPS_PER_MESSAGE = 3;
export const QUEUE_CUTOFF_PCT = 90;

const aadFor = (updateId) => `update:${updateId}`;

export function sealUpdate(update) {
  return encrypt(JSON.stringify(update), aadFor(update.update_id));
}

export function openUpdate(updateId, payload) {
  return JSON.parse(decrypt(payload, aadFor(updateId)));
}

/**
 * Decides where to put the update and returns the HTTP status for Telegram.
 * @param {object} update Telegram update
 * @param {object} deps
 * @param {(message: object, options: object) => Promise<unknown>} deps.enqueue send to Vercel Queues
 * @param {(promise: Promise<unknown>) => void} deps.defer waitUntil on Vercel
 * @param {(update: object) => Promise<unknown>} deps.process update processing
 */
export async function acceptUpdate(update, { enqueue, defer, process, store = db } = {}) {
  const updateId = update?.update_id;
  // Garbage without update_id is pointless to retry: answer 200 so Telegram lets go.
  if (!Number.isSafeInteger(updateId)) return 200;

  const payload = sealUpdate(update);

  let budgetOk;
  try {
    budgetOk = await store.queueBudgetTake(QUEUE_OPS_PER_MESSAGE, QUEUE_MONTHLY_OPS, QUEUE_CUTOFF_PCT);
  } catch (error) {
    // The database is down, which is no reason not to try the queue.
    console.warn(`[ingest] бюджет очереди не проверен: ${error.name}`);
    budgetOk = true;
  }

  if (budgetOk) {
    try {
      await enqueue(
        { updateId, payload },
        // A repeated delivery of the same update from Telegram doesn't create a second message.
        { idempotencyKey: `update-${updateId}` },
      );
      return 200;
    } catch (error) {
      console.warn(`[ingest] очередь недоступна (${error.name}), фолбэк без очереди`);
    }
  } else {
    console.warn("[ingest] бюджет Queues ≥ 90%, фолбэк без очереди");
  }

  let status;
  try {
    status = await store.markReceived(updateId, payload);
  } catch (error) {
    // Neither queue nor database: 503, and Telegram will redeliver on its own (R19).
    console.error(`[ingest] апдейт ${updateId} не сохранён нигде (${error.name}), 503`);
    return 503;
  }

  if (status !== "done") {
    defer(
      process(update).catch((error) => {
        // The row stays received with ciphertext: cron will finish processing it.
        console.error(`[ingest] фоновая обработка ${updateId} упала: ${error.name}: ${error.message}`);
      }),
    );
  }
  return 200;
}

/**
 * Processes an update strictly by the R3/R10 contract: a duplicate is skipped only
 * after done. Throws if the handler failed, so the queue redelivers.
 * @returns {Promise<"done" | "skipped">}
 */
export async function processUpdate(update, { handle, store = db }) {
  const updateId = update.update_id;
  const status = await store.markReceived(updateId);
  if (status === "done") return "skipped";

  await handle(update);
  await store.markDone(updateId);
  return "done";
}
