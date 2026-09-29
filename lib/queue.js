// Vercel Queues client and core dependencies for the Vercel entry points.
// One instance per process: only QueueClient has handleNodeCallback, and it's
// convenient to take send from the same place. The core (lib/handle.js,
// lib/session.js) doesn't import this module; the queue is injected into it.
import { QueueClient } from "@vercel/queue";
import { DEBOUNCE_TOPIC } from "./session.js";
import { botUsername } from "./telegram.js";

const queue = new QueueClient();

export const { send, handleNodeCallback } = queue;

export const enqueueDebounce = (check, options) => send(DEBOUNCE_TOPIC, check, options);

export async function vercelEnv() {
  return { enqueue: enqueueDebounce, botUsername: await botUsername() };
}
