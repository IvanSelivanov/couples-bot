// Команды и меню лички (DR16), данные и доступ (дизайн-док «Отзыв и
// удаление»; DR19, DR20, R25).
//
//   меню: «Подготовить сообщение · Мои заметки · Данные и доступ · Помощь»;
//         на паузе, поставленной мной, — «Снять паузу» (меню следует за состоянием)
//   данные и доступ ─▶ действие ─▶ подтверждение с перечнем и «нельзя отменить»
//                                   ─▶ пауза / отзыв после моего сигнала?
//                                        ─▶ «Партнёр поймёт, что это сделал ты» ─▶ ещё раз да
//                                   ─▶ выполнение ─▶ ответ в личку + объявление в группе
//
// Отозвавший согласие получает ответ только на /consent и /forget.
// Модуль не отправляет сам: возвращает { dm: [...], group: [ключи текстов] }.

import * as db from "./db.js";
import { text as copyText } from "./copy.js";
import { keyboard } from "./format.js";
import { escapeHtml } from "./telegram.js";

const baseLang = (lang) => String(lang ?? "en").split(/[-_]/)[0].toLowerCase();

// Команда → действие. Удаления и отзыв требуют подтверждения.
export const COMMANDS = {
  menu: "menu",
  start: "menu",
  forget: "ask:forget",
  forget_group: "ask:forget_group",
  revoke: "ask:revoke",
  consent: "do:consent",
  flag_clear: "do:flag_clear",
  pause: "do:pause",
  resume: "do:resume",
  notes: "notes",
  help: "help",
};

const NEEDS_CONFIRM = new Set(["forget", "forget_group", "revoke"]);
const IRREVERSIBLE = new Set(["forget", "forget_group"]);
const SIGNAL_SENSITIVE = new Set(["pause", "revoke"]);

export async function mainMenu(member, couple, textFn = copyText) {
  const lang = baseLang(member.lang);
  const t = (key) => textFn(lang, key);
  const buttons = [
    { labels: [await t("menu.compose")], data: "dr:compose" },
    { labels: [await t("menu.notes")], data: "mn:notes" },
    { labels: [await t("menu.data")], data: "mn:data" },
    { labels: [await t("menu.help")], data: "mn:help" },
  ];
  if (couple.state === "paused" && couple.pausedBy === Number(member.user_id)) {
    buttons.unshift({ labels: [await t("menu.resume")], data: "mn:do:resume" });
  }
  return { text: escapeHtml(await t("menu.title")), reply_markup: keyboard(buttons) };
}

export async function dataMenu(member, couple, textFn = copyText) {
  const lang = baseLang(member.lang);
  const t = (key) => textFn(lang, key);
  const buttons = [
    { labels: [await t("data.forget")], data: "mn:ask:forget" },
    { labels: [await t("data.forget_group")], data: "mn:ask:forget_group" },
    member.revoked_at
      ? { labels: [await t("data.consent")], data: "mn:do:consent" }
      : { labels: [await t("data.revoke")], data: "mn:ask:revoke" },
    { labels: [await t("data.flag_clear")], data: "mn:do:flag_clear" },
  ];
  if (couple.state === "active") buttons.push({ labels: [await t("data.pause")], data: "mn:do:pause" });
  return { text: `<b>${escapeHtml(await t("data.title"))}</b>`, reply_markup: keyboard(buttons) };
}

async function confirmation(op, member, textFn, { anonymity = false } = {}) {
  const lang = baseLang(member.lang);
  const t = (key) => textFn(lang, key);
  const body = anonymity ? await t("data.anonymity_warning") : await t(`data.${op}_confirm`);
  const tail = !anonymity && IRREVERSIBLE.has(op) ? `\n\n<b>${escapeHtml(await t("menu.irreversible"))}</b>` : "";
  return {
    text: escapeHtml(body) + tail,
    reply_markup: keyboard([
      { labels: [await t("data.confirm_button")], data: anonymity ? `mn:anon:${op}` : `mn:do:${op}` },
      { labels: [await t("data.cancel_button")], data: "mn:cancel" },
    ]),
  };
}

/**
 * @param {object} member строка members (user_id, lang, revoked_at)
 * @param {object} couple пара с участниками (coupleByMember)
 * @param {string} action "menu" | "data" | "ask:op" | "do:op" | "anon:op" | "cancel" | "help" | "notes"
 * @returns {Promise<{dm: object[], group: string[], delegate?: string}>}
 */
export async function commandAction(member, couple, action, { store = db, textFn = copyText } = {}) {
  const userId = Number(member.user_id);
  const lang = baseLang(member.lang);
  const say = async (key) => ({ text: escapeHtml(await textFn(lang, key)) });
  const [kind, op] = action.split(":");

  // Отозвавший согласие: только /consent и /forget (дизайн-док «Отзыв»).
  if (member.revoked_at && !["consent", "forget"].includes(op) && kind !== "cancel") {
    return { dm: [await say("data.only_consent_forget")], group: [] };
  }

  switch (kind) {
    case "menu":
      return { dm: [await mainMenu(member, couple, textFn)], group: [] };
    case "data":
      return { dm: [await dataMenu(member, couple, textFn)], group: [] };
    case "help":
    case "notes":
      return { dm: [], group: [], delegate: kind };
    case "cancel":
      return { dm: [await say("data.cancelled")], group: [] };
    case "ask":
      if (!NEEDS_CONFIRM.has(op)) return { dm: [], group: [] };
      return { dm: [await confirmation(op, member, textFn)], group: [] };
    case "do":
    case "anon": {
      // Пауза и отзыв после моего собственного сигнала выдают меня партнёру:
      // сначала предупреждение, выполнение — только после второго «да».
      if (kind === "do" && SIGNAL_SENSITIVE.has(op) && (await store.hasOwnSignal(userId))) {
        return { dm: [await confirmation(op, member, textFn, { anonymity: true })], group: [] };
      }
      return execute(op, member, couple, { store, say });
    }
    default:
      return { dm: [], group: [] };
  }
}

async function execute(op, member, couple, { store, say }) {
  const userId = Number(member.user_id);
  switch (op) {
    case "forget":
      await store.forgetMember(userId);
      return { dm: [await say("data.forget_done")], group: [] };
    case "forget_group":
      // Хватает одного партнёра; абьюз-флаги остаются (DR20).
      await store.forgetGroup(couple.id);
      return { dm: [await say("data.forget_group_done")], group: ["data.forget_group_notice"] };
    case "revoke": {
      const t = await store.coupleTransition(couple.id, "revoke", userId);
      return t.ok ? { dm: [await say("data.revoke_done")], group: ["state.revoked"] } : { dm: [await say("state.not_active")], group: [] };
    }
    case "consent": {
      const t = await store.coupleTransition(couple.id, "consent", userId);
      if (!t.ok) return { dm: [await say("state.not_active")], group: [] };
      // R25: пауза переживает отзыв — если вернулись в paused, в группе молчим.
      return { dm: [await say("data.consent_done")], group: t.to === "active" ? ["state.resumed"] : [] };
    }
    case "flag_clear": {
      const cleared = await store.flagClear(userId);
      return { dm: [await say(cleared > 0 ? "data.flag_clear_done" : "data.flag_clear_none")], group: [] };
    }
    case "pause": {
      const t = await store.coupleTransition(couple.id, "pause", userId);
      return t.ok ? { dm: [await say("state.paused")], group: ["state.paused"] } : { dm: [await say("state.not_active")], group: [] };
    }
    case "resume": {
      const t = await store.coupleTransition(couple.id, "resume", userId);
      if (t.ok) return { dm: [await say("state.resumed")], group: ["state.resumed"] };
      return { dm: [await say(t.reason === "not_pauser" ? "state.resume_not_pauser" : "state.not_active")], group: [] };
    }
    default:
      return { dm: [], group: [] };
  }
}
