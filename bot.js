#!/usr/bin/env node
// Локальный режим: long polling вместо вебхука и без очереди.
//
//   npm run db:start && npm run bot
//
// Обработка та же, что в проде (processUpdate → handleUpdate), включая
// дедупликацию через processed_updates, поэтому нужна локальная база.
// processUpdate зовётся без await: долгая обработка одного апдейта не держит
// polling, а ошибки только логируются.

import { call, TelegramError } from "./lib/telegram.js";
import { processUpdate } from "./lib/ingest.js";
import { ALLOWED_UPDATES, handleUpdate } from "./lib/handle.js";

let offset;

process.on("SIGINT", () => {
  console.log("\nОстанавливаюсь.");
  process.exit(0);
});

// Вебхук и getUpdates несовместимы: Telegram отвечает 409, пока стоит вебхук.
await call("deleteWebhook", { drop_pending_updates: false });
console.log("Слушаю. Ctrl-C чтобы остановить.");

for (;;) {
  let updates;
  try {
    // allowed_updates тот же, что при setWebhook (дизайн-док, «Модули»).
    updates = await call("getUpdates", { timeout: 30, offset, allowed_updates: ALLOWED_UPDATES }, { timeoutMs: 40_000 });
  } catch (error) {
    if (error instanceof TelegramError || error.name === "TimeoutError") {
      console.warn(`[polling] ${error.message}, повтор через 3 с`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      continue;
    }
    throw error;
  }

  for (const update of updates) {
    offset = update.update_id + 1;
    processUpdate(update, { handle: handleUpdate }).catch((error) => {
      console.error(`[polling] апдейт ${update.update_id} упал: ${error.name}: ${error.message}`);
    });
  }
}
