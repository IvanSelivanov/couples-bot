// Потребитель отложенных проверок дебаунса (топик "debounce", R1).
// Доставка at-least-once: повтор проверки безопасен — решение читается из
// базы заново, а ответить может только владелец аренды (R2, R12).

import { handleNodeCallback, vercelEnv } from "../lib/queue.js";
import { respond, runCheck, scheduleTail } from "../lib/session.js";

export default handleNodeCallback(
  async (check) => {
    // Если хвост R11 не встанет в очередь, он ждёт сном внутри этой же доставки.
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
