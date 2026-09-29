#!/usr/bin/env node
// Local mode: long polling instead of the webhook, no queue.
//
//   npm run db:start && npm run bot
//
// Processing is the same as in production (processUpdate → handleUpdate),
// including deduplication via processed_updates, so a local database is needed.
// processUpdate is called without await: slow processing of one update doesn't
// block polling, and errors are only logged.

import { botUsername, call, TelegramError } from "./lib/telegram.js";
import { processUpdate } from "./lib/ingest.js";
import { ALLOWED_UPDATES, handleUpdate } from "./lib/handle.js";

let offset;

process.on("SIGINT", () => {
  console.log("\nStopping.");
  process.exit(0);
});

// Webhook and getUpdates don't mix: Telegram answers 409 while a webhook is set.
await call("deleteWebhook", { drop_pending_updates: false });
console.log("Listening. Ctrl-C to stop.");

for (;;) {
  let updates;
  try {
    // Same allowed_updates as in setWebhook (design doc, "Modules").
    updates = await call("getUpdates", { timeout: 30, offset, allowed_updates: ALLOWED_UPDATES }, { timeoutMs: 40_000 });
  } catch (error) {
    if (error instanceof TelegramError || error.name === "TimeoutError") {
      console.warn(`[polling] ${error.message}, retrying in 3 s`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      continue;
    }
    throw error;
  }

  for (const update of updates) {
    offset = update.update_id + 1;
    processUpdate(update, { handle: async (u) => handleUpdate(u, { botUsername: await botUsername() }) }).catch((error) => {
      console.error(`[polling] update ${update.update_id} failed: ${error.name}: ${error.message}`);
    });
  }
}
