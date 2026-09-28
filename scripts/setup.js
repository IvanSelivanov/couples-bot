#!/usr/bin/env node
// Разовая настройка бота после деплоя (DR16, R10):
//   node --env-file=.env scripts/setup.js https://<проект>.vercel.app
//
// - setWebhook с секретом и тем же allowed_updates, что у локального polling;
// - setMyCommands отдельно для групп и личек, на ru и en (остальные языки
//   видят английский список).

import { call } from "../lib/telegram.js";
import { ALLOWED_UPDATES } from "../lib/handle.js";
import ru from "../lib/copy/ru.js";
import en from "../lib/copy/en.js";

const base = process.argv[2];
if (!base?.startsWith("https://")) {
  console.error("Укажи адрес деплоя: node --env-file=.env scripts/setup.js https://<проект>.vercel.app");
  process.exit(1);
}
if (!process.env.WEBHOOK_SECRET) {
  console.error("WEBHOOK_SECRET не задан");
  process.exit(1);
}

const GROUP = ["help", "pause", "translate"];
const PRIVATE = ["menu", "draft", "notes", "pause", "resume", "help"];

const commands = (catalog, names) => names.map((command) => ({ command, description: catalog[`cmd.${command}`] }));

await call("setWebhook", {
  url: `${base.replace(/\/$/, "")}/api`,
  secret_token: process.env.WEBHOOK_SECRET,
  allowed_updates: ALLOWED_UPDATES,
  drop_pending_updates: false,
});
console.log("Вебхук установлен");

for (const [scope, names] of [
  [{ type: "all_group_chats" }, GROUP],
  [{ type: "all_private_chats" }, PRIVATE],
]) {
  await call("setMyCommands", { scope, commands: commands(en, names) });
  await call("setMyCommands", { scope, language_code: "ru", commands: commands(ru, names) });
}
console.log("Команды установлены для групп и личек (ru, en)");
