// Telegram webhook. Checks the secret and stores the update durably before
// responding (lib/ingest.js). No work on the update's content happens here.

import { waitUntil } from "@vercel/functions";
import { acceptUpdate, processUpdate, UPDATES_TOPIC } from "../lib/ingest.js";
import { handleUpdate } from "../lib/handle.js";
import { send, vercelEnv } from "../lib/queue.js";

export default async function handler(request, response) {
  // Secret check first: foreign requests must not cost queue or database work.
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret || request.headers["x-telegram-bot-api-secret-token"] !== secret) {
    response.status(403).json({ ok: false });
    return;
  }

  const update = typeof request.body === "string" ? safeParse(request.body) : request.body;

  const status = await acceptUpdate(update, {
    enqueue: (message, options) => send(UPDATES_TOPIC, message, options),
    defer: waitUntil,
    process: (u) => processUpdate(u, { handle: (x) => handleUpdate(x, vercelEnv()) }),
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
