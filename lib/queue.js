// Клиент Vercel Queues и зависимости ядра для точек входа на Vercel.
// Один экземпляр на процесс: handleNodeCallback есть только у QueueClient,
// а send удобно брать оттуда же. Ядро (lib/handle.js, lib/session.js) этот
// модуль не импортирует — очередь приходит к нему зависимостью.
import { QueueClient } from "@vercel/queue";
import { DEBOUNCE_TOPIC } from "./session.js";

const queue = new QueueClient();

export const { send, handleNodeCallback } = queue;

export function vercelEnv() {
  return {
    enqueue: (check, options) => send(DEBOUNCE_TOPIC, check, options),
    botUsername: process.env.BOT_USERNAME,
  };
}
