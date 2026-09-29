// Consumer of delayed debounce checks ("debounce" topic, R1).
// Delivery is at-least-once: re-running a check is safe, the decision is read
// from the database again and only the lease owner may reply (R2, R12).

import { handleNodeCallback, vercelEnv } from "../lib/queue.js";
import { respond, runCheck, scheduleTail } from "../lib/session.js";

export default handleNodeCallback(
  async (check) => {
    // If the R11 tail can't be queued, it waits with sleep inside this same delivery.
    const pending = [];
    const deps = { enqueue: vercelEnv().enqueue, defer: (p) => pending.push(p) };
    const respondWithTail = (w, m) => respond(w, m, { scheduleTail: (wi, mi) => scheduleTail(wi, mi, deps) });
    deps.run = (c) => runCheck(c, { respond: respondWithTail });
    await deps.run(check);
    await Promise.allSettled(pending);
  },
  {
    retry: (error, metadata) => {
      if (metadata.deliveryCount >= 5) {
        console.error(`[queue] проверка дебаунса: ${metadata.deliveryCount} неудач, снимаем`);
        return { acknowledge: true };
      }
      return { afterSeconds: 5 * metadata.deliveryCount };
    },
  },
);
