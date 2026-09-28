// Клиент Vercel Queues. Один экземпляр на процесс: handleNodeCallback есть
// только у QueueClient, а send удобно брать оттуда же.
import { QueueClient } from "@vercel/queue";

const queue = new QueueClient();

export const { send, handleNodeCallback } = queue;
