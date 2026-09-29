// Points Telegram at a deployment (DR16, R10). Used by the manual
// `npm run setup` and by the Vercel build (scripts/vercel-build.js).
//
// - setWebhook with the secret and the same allowed_updates as local polling;
// - setMyCommands separately for groups and private chats, in ru and en (other
//   languages see the English list).
// Both calls are idempotent, so running this on every deploy is safe.

import { call } from "../lib/telegram.js";
import { ALLOWED_UPDATES } from "../lib/handle.js";
import { webhookSecret } from "../lib/crypto.js";
import ru from "../lib/copy/ru.js";
import en from "../lib/copy/en.js";

const GROUP = ["help", "pause", "translate"];
const PRIVATE = ["menu", "draft", "notes", "pause", "resume", "help"];

const commands = (catalog, names) => names.map((command) => ({ command, description: catalog[`cmd.${command}`] }));

/**
 * @param {string} base deployment URL, e.g. https://couples-bot.vercel.app
 * @param {{ api?: typeof call, log?: (line: string) => void }} [deps]
 */
export async function configureTelegram(base, { api = call, log = console.log } = {}) {
  if (!/^https:\/\//.test(base ?? "")) throw new Error(`deployment URL must start with https://, got: ${base}`);
  await api("setWebhook", {
    url: `${base.replace(/\/$/, "")}/api`,
    secret_token: webhookSecret(),
    allowed_updates: ALLOWED_UPDATES,
    drop_pending_updates: false,
  });
  log(`Webhook set: ${base.replace(/\/$/, "")}/api`);

  for (const [scope, names] of [
    [{ type: "all_group_chats" }, GROUP],
    [{ type: "all_private_chats" }, PRIVATE],
  ]) {
    await api("setMyCommands", { scope, commands: commands(en, names) });
    await api("setMyCommands", { scope, language_code: "ru", commands: commands(ru, names) });
  }
  log("Commands set for groups and private chats (ru, en)");
}
