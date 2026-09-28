// Потребитель отложенных проверок дебаунса (топик "debounce", R1).
// Доставка at-least-once: повтор проверки безопасен — решение читается из
// базы заново, а ответить может только владелец аренды (R2, R12).

import { handleNodeCallback } from "../lib/queue.js";
import { respond, runCheck } from "../lib/session.js";

export default handleNodeCallback(
  async (check) => {
    await runCheck(check, { respond });
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
