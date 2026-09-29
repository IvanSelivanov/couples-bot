// Consumer of the updates queue: Vercel calls this function for every
// message on the "updates" topic (trigger in vercel.json). Delivery is
// at-least-once; processUpdate drops duplicates (R3, R10).

import { openUpdate, processUpdate } from "../lib/ingest.js";
import { handleUpdate } from "../lib/handle.js";
import { handleNodeCallback, vercelEnv } from "../lib/queue.js";
import { CryptoError } from "../lib/crypto.js";

// Retry ceiling: after it the update is considered hopeless. The default
// one-day message retention limits attempts anyway.
const MAX_DELIVERIES = 12;

export default handleNodeCallback(
  async ({ updateId, payload }) => {
    const update = openUpdate(updateId, payload);
    await processUpdate(update, { handle: (u) => handleUpdate(u, vercelEnv()) });
  },
  {
    retry: (error, metadata) => {
      // The ciphertext didn't open (lost key, tampering): retrying won't help.
      if (error instanceof CryptoError) {
        console.error(`[queue] апдейт не расшифрован, снимаем с очереди: ${error.message}`);
        return { acknowledge: true };
      }
      if (metadata.deliveryCount >= MAX_DELIVERIES) {
        console.error(`[queue] ${metadata.deliveryCount} неудачных доставок, снимаем с очереди`);
        return { acknowledge: true };
      }
      // 10 s → 20 s → 40 s → … at most 5 minutes.
      return { afterSeconds: Math.min(300, 5 * 2 ** metadata.deliveryCount) };
    },
  },
);
