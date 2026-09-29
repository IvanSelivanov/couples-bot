#!/usr/bin/env node
// Guest Mode spike (Bot API 10.0): a gate before the main work.
// Answers the questions the design depends on (DR12, R decisions about Guest Mode):
//   1. Does guest_message arrive in a private conversation between two people (1:1)?
//   2. Does it include the replied-to message (reply_to_message), and whose is it?
//   3. Is there a from.language_code?
//   4. Does HTML with <blockquote expandable> work in an answerGuestQuery reply?
//   5. How long can the reply be delayed (SPIKE_DELAY_MS)?
//   6. Can the reply be edited later via inline_message_id?
//   7. Can a voice message or video note from reply_to_message be downloaded?
//
//   npm run spike:guest            (needs BOT_TOKEN in .env)
//   SPIKE_DELAY_MS=60000 npm run spike:guest   — test a slow reply
//
// Throwaway code: the bot doesn't import it.

import { call, download, getFile, TelegramError } from "../lib/telegram.js";

const delayMs = Number(process.env.SPIKE_DELAY_MS ?? 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const me = await call("getMe", {});
console.log(`Бот @${me.username}; supports_guest_queries = ${me.supports_guest_queries ?? "нет поля"}`);
if (!me.supports_guest_queries) {
  console.log("Guest Mode выключен: BotFather → MiniApp → настройки бота → Guest Mode.");
}

// Webhook and getUpdates don't mix: while a webhook is set, polling gets 409.
await call("deleteWebhook", { drop_pending_updates: false });

console.log(`Жду guest_message. Задержка ответа: ${delayMs} мс. Ctrl-C — выход.\n`);

let offset;
for (;;) {
  let updates;
  try {
    updates = await call(
      "getUpdates",
      { timeout: 30, offset, allowed_updates: ["message", "guest_message"] },
      { timeoutMs: 40_000 },
    );
  } catch (error) {
    if (error instanceof TelegramError || error.name === "TimeoutError") {
      console.warn(`[polling] ${error.message}`);
      await sleep(3000);
      continue;
    }
    throw error;
  }

  for (const update of updates) {
    offset = update.update_id + 1;
    if (update.guest_message) await handleGuest(update.guest_message);
    else console.log(`(обычный апдейт: ${Object.keys(update).filter((k) => k !== "update_id").join(", ")})`);
  }
}

async function handleGuest(message) {
  const reply = message.reply_to_message;
  console.log("=== guest_message ===");
  console.log({
    chat_type: message.chat?.type,
    chat_id: message.chat?.id,
    from_id: message.from?.id,
    from_language_code: message.from?.language_code ?? "(нет)",
    text: message.text,
    has_reply_to_message: Boolean(reply),
    reply_from_id: reply?.from?.id,
    reply_text: reply?.text,
    reply_has_voice: Boolean(reply?.voice || reply?.video_note),
    guest_query_id: message.guest_query_id,
    keys: Object.keys(message),
  });

  // 7. Can a voice message or video note from the reply be downloaded when the bot isn't in the chat?
  const media = reply?.voice ?? reply?.video_note;
  if (media) {
    try {
      const file = await getFile(media.file_id);
      const bytes = await download(file.file_path);
      console.log(`Медиа из реплая: duration=${media.duration} с, скачано ${bytes.length} байт`);
    } catch (error) {
      console.log("Медиа из реплая: ОШИБКА —", error.message);
    }
  }

  if (delayMs) {
    console.log(`Жду ${delayMs} мс перед ответом…`);
    await sleep(delayMs);
  }

  const html =
    "<b>Спайк Guest Mode</b>\n" +
    `Задержка ответа: ${delayMs} мс\n` +
    "<blockquote expandable>Свёрнутая цитата: если она свёрнута, HTML и expandable работают.\n" +
    "Вторая строка.\nТретья строка.\nЧетвёртая строка.</blockquote>";

  try {
    const sent = await call("answerGuestQuery", {
      guest_query_id: message.guest_query_id,
      result: {
        type: "article",
        id: "spike-1",
        title: "spike",
        input_message_content: { message_text: html, parse_mode: "HTML" },
      },
    });
    console.log("answerGuestQuery →", sent);

    if (sent?.inline_message_id) {
      await sleep(5000);
      try {
        await call("editMessageText", {
          inline_message_id: sent.inline_message_id,
          text: `${html}\n\n<i>Отредактировано через 5 с по inline_message_id.</i>`,
          parse_mode: "HTML",
        });
        console.log("editMessageText по inline_message_id: OK");
      } catch (error) {
        console.log("editMessageText по inline_message_id: ОШИБКА —", error.message);
      }
    }
  } catch (error) {
    console.log("answerGuestQuery: ОШИБКА —", error.message);
  }
  console.log();
}
