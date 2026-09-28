// Потребитель очереди апдейтов: Vercel зовёт эту функцию на каждое
// сообщение топика "updates" (триггер в vercel.json). Доставка
// at-least-once, дубли отсекает processUpdate (R3, R10).

import { openUpdate, processUpdate } from "../lib/ingest.js";
import { handleUpdate } from "../lib/handle.js";
import { handleNodeCallback } from "../lib/queue.js";
import { CryptoError } from "../lib/crypto.js";

// Потолок повторов: после него апдейт считается безнадёжным. Сутки хранения
// сообщения по умолчанию всё равно ограничивают попытки.
const MAX_DELIVERIES = 12;

export default handleNodeCallback(
  async ({ updateId, payload }) => {
    const update = openUpdate(updateId, payload);
    await processUpdate(update, { handle: handleUpdate });
  },
  {
    retry: (error, metadata) => {
      // Шифротекст не открылся (потерян ключ, подмена) — повтор не поможет.
      if (error instanceof CryptoError) {
        console.error(`[queue] апдейт не расшифрован, снимаем с очереди: ${error.message}`);
        return { acknowledge: true };
      }
      if (metadata.deliveryCount >= MAX_DELIVERIES) {
        console.error(`[queue] ${metadata.deliveryCount} неудачных доставок, снимаем с очереди`);
        return { acknowledge: true };
      }
      // 10 с → 20 с → 40 с → … не больше 5 минут.
      return { afterSeconds: Math.min(300, 5 * 2 ** metadata.deliveryCount) };
    },
  },
);
