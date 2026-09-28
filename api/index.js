// Вебхук Telegram. Проверяет секрет и сохраняет апдейт долговечно до ответа
// (lib/ingest.js). Никакой работы с содержимым здесь нет.

import { waitUntil } from "@vercel/functions";
import { acceptUpdate, processUpdate, UPDATES_TOPIC } from "../lib/ingest.js";
import { handleUpdate } from "../lib/handle.js";
import { send } from "../lib/queue.js";

export default async function handler(request, response) {
  // Секрет первой строкой: чужие запросы не должны тратить ни очередь, ни базу.
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret || request.headers["x-telegram-bot-api-secret-token"] !== secret) {
    response.status(403).json({ ok: false });
    return;
  }

  const update = typeof request.body === "string" ? safeParse(request.body) : request.body;

  const status = await acceptUpdate(update, {
    enqueue: (message, options) => send(UPDATES_TOPIC, message, options),
    defer: waitUntil,
    process: (u) => processUpdate(u, { handle: handleUpdate }),
  });

  response.status(status).json({ ok: status === 200 });
}

function safeParse(body) {
  try {
    return JSON.parse(body);
  } catch {
    console.error("[webhook] тело запроса не JSON");
    return null;
  }
}
