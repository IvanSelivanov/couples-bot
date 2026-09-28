// Долговечный приём апдейта до ответа Telegram (R10, R19, R1, R27).
//
// В tgbot вебхук отвечал 200 сразу и обрабатывал в waitUntil: если инстанс
// падал посреди работы, апдейт терялся, а Telegram его уже не повторял.
// Здесь 200 уходит только когда апдейт где-то сохранён:
//
//   апдейт ─▶ бюджет Queues < 90%? ─ да ─▶ send в очередь ─ ok ─▶ 200
//                  │ нет / ошибка            │ ошибка
//                  ▼                         ▼
//             фолбэк: processed_updates = received + шифротекст ─ ok ─▶ обработка в defer, 200
//                                                               └ ошибка ─▶ 503, Telegram повторит
//
// Обработка (processUpdate) одинакова для очереди, фолбэка и локального
// polling: дубль пропускается только после done (R3, R10), потом payload
// стирается (R27). Сам апдейт в очереди и в фолбэке лежит шифротекстом:
// в нём может быть личка (R27).

import * as db from "./db.js";
import { decrypt, encrypt } from "./crypto.js";

export const UPDATES_TOPIC = "updates";

// Бюджет Vercel Queues (R1): 1 000 000 операций в месяц на Hobby, ~3 на сообщение.
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
 * Решает, куда положить апдейт, и возвращает HTTP-статус для Telegram.
 * @param {object} update апдейт Telegram
 * @param {object} deps
 * @param {(message: object, options: object) => Promise<unknown>} deps.enqueue send в Vercel Queues
 * @param {(promise: Promise<unknown>) => void} deps.defer waitUntil на Vercel
 * @param {(update: object) => Promise<unknown>} deps.process обработка апдейта
 */
export async function acceptUpdate(update, { enqueue, defer, process, store = db } = {}) {
  const updateId = update?.update_id;
  // Мусор без update_id повторять бессмысленно: ответ 200, чтобы Telegram отстал.
  if (!Number.isSafeInteger(updateId)) return 200;

  const payload = sealUpdate(update);

  let budgetOk;
  try {
    budgetOk = await store.queueBudgetTake(QUEUE_OPS_PER_MESSAGE, QUEUE_MONTHLY_OPS, QUEUE_CUTOFF_PCT);
  } catch (error) {
    // База недоступна — это не повод не пробовать очередь.
    console.warn(`[ingest] бюджет очереди не проверен: ${error.name}`);
    budgetOk = true;
  }

  if (budgetOk) {
    try {
      await enqueue(
        { updateId, payload },
        // Повторная доставка того же апдейта от Telegram не создаёт второе сообщение.
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
    // Ни очереди, ни базы: 503, и Telegram повторит доставку сам (R19).
    console.error(`[ingest] апдейт ${updateId} не сохранён нигде (${error.name}), 503`);
    return 503;
  }

  if (status !== "done") {
    defer(
      process(update).catch((error) => {
        // Строка осталась received с шифротекстом: её дообработает cron.
        console.error(`[ingest] фоновая обработка ${updateId} упала: ${error.name}: ${error.message}`);
      }),
    );
  }
  return 200;
}

/**
 * Обрабатывает апдейт ровно по контракту R3/R10: дубль пропускается только
 * после done. Бросает, если обработчик упал: очередь повторит доставку.
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
