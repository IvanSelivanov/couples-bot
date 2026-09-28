#!/usr/bin/env node
// Спайк Guest Mode (Bot API 10.0) — гейт перед основной работой.
// Отвечает на вопросы, от которых зависит дизайн (DR12, R-решения про Guest):
//   1. Приходит ли guest_message в личной переписке двух людей (1:1)?
//   2. Есть ли в нём сообщение, на которое ответили (reply_to_message), и чьё оно?
//   3. Есть ли from.language_code?
//   4. Работает ли HTML с <blockquote expandable> в ответе answerGuestQuery?
//   5. Сколько можно тянуть с ответом (SPIKE_DELAY_MS)?
//   6. Можно ли потом отредактировать ответ по inline_message_id?
//
//   npm run spike:guest            (нужен BOT_TOKEN в .env)
//   SPIKE_DELAY_MS=60000 npm run spike:guest   — проверить долгий ответ
//
// Код одноразовый: в бота он не импортируется.

import { call, TelegramError } from "../lib/telegram.js";

const delayMs = Number(process.env.SPIKE_DELAY_MS ?? 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const me = await call("getMe", {});
console.log(`Бот @${me.username}; supports_guest_queries = ${me.supports_guest_queries ?? "нет поля"}`);
if (!me.supports_guest_queries) {
  console.log("Guest Mode выключен: BotFather → MiniApp → настройки бота → Guest Mode.");
}

// Вебхук и getUpdates несовместимы: если вебхук стоит, polling получит 409.
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
