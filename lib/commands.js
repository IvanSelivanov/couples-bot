// Private chat commands and menu (DR16), data and access (design doc "Revocation and
// deletion"; DR19, DR20, R25).
//
//   menu: "Prepare a message · My notes · Data and access · Help";
//         during a pause I set: "Resume" (the menu follows the state)
//   data and access ─▶ action ─▶ confirmation with a list and "can't be undone"
//                                ─▶ pause / revoke right after my own signal?
//                                     ─▶ "Your partner will know it was you" ─▶ yes again
//                                ─▶ run ─▶ reply in private + announcement in the group
//
// A member who revoked consent gets answers only to /consent and /forget.
// The module sends nothing itself: it returns { dm: [...], group: [text keys] }.

import * as db from "./db.js";
import { text as copyText } from "./copy.js";
import { keyboard } from "./format.js";
import { escapeHtml } from "./telegram.js";

const baseLang = (lang) => String(lang ?? "en").split(/[-_]/)[0].toLowerCase();

// Command → action. Deletions and revocation require confirmation.
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
 * @param {object} member members row (user_id, lang, revoked_at)
 * @param {object} couple couple with its members (coupleByMember)
 * @param {string} action "menu" | "data" | "ask:op" | "do:op" | "anon:op" | "cancel" | "help" | "notes"
 * @returns {Promise<{dm: object[], group: string[], delegate?: string}>}
 */
export async function commandAction(member, couple, action, { store = db, textFn = copyText } = {}) {
  const userId = Number(member.user_id);
  const lang = baseLang(member.lang);
  const say = async (key) => ({ text: escapeHtml(await textFn(lang, key)) });
  const [kind, op] = action.split(":");

  // A member who revoked consent: only /consent and /forget (design doc "Revocation").
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
      // A pause or revocation right after my own signal gives me away to the partner:
      // warn first, run only after a second "yes".
      if (kind === "do" && SIGNAL_SENSITIVE.has(op) && (await store.hasOwnSignal(userId))) {
        return { dm: [await confirmation(op, member, textFn, { anonymity: true })], group: [] };
      }
      return execute(op, member, couple, { store, say });
    }
    default:
      return { dm: [], group: [] };
  }
}

// The command didn't apply: explain why and what to do, based on the couple's state.
// "I'm not running the conversation right now" without a reason tells the user nothing.
const REFUSAL_BY_STATE = {
  onboarding: "state.why_onboarding",
  paused: "state.why_paused",
  revoked: "state.why_revoked",
  suspended: "state.why_suspended",
};

/**
 * @param {{reason?: string, state?: string}} t coupleTransition result (or { state } for checks without a transition)
 * @param {string} [op] command: resume/consent in the active state have their own answers
 */
export function refusalKey(t, op) {
  if (t.reason === "not_pauser") return "state.resume_not_pauser";
  if (t.state === "active" && op === "resume") return "state.not_paused";
  if (t.state === "active" && op === "consent") return "data.consent_already";
  return REFUSAL_BY_STATE[t.state] ?? "state.not_active";
}

async function execute(op, member, couple, { store, say }) {
  const userId = Number(member.user_id);
  switch (op) {
    case "forget":
      await store.forgetMember(userId);
      return { dm: [await say("data.forget_done")], group: [] };
    case "forget_group":
      // One partner is enough; abuse flags stay (DR20).
      await store.forgetGroup(couple.id);
      return { dm: [await say("data.forget_group_done")], group: ["data.forget_group_notice"] };
    case "revoke": {
      const t = await store.coupleTransition(couple.id, "revoke", userId);
      return t.ok ? { dm: [await say("data.revoke_done")], group: ["state.revoked"] } : { dm: [await say(refusalKey(t, op))], group: [] };
    }
    case "consent": {
      const t = await store.coupleTransition(couple.id, "consent", userId);
      if (!t.ok) return { dm: [await say(refusalKey(t, op))], group: [] };
      // R25: a pause survives revocation; if we're back in paused, stay quiet in the group.
      return { dm: [await say("data.consent_done")], group: t.to === "active" ? ["state.resumed"] : [] };
    }
    case "flag_clear": {
      const cleared = await store.flagClear(userId);
      return { dm: [await say(cleared > 0 ? "data.flag_clear_done" : "data.flag_clear_none")], group: [] };
    }
    case "pause": {
      const t = await store.coupleTransition(couple.id, "pause", userId);
      return t.ok ? { dm: [await say("state.paused")], group: ["state.paused"] } : { dm: [await say(refusalKey(t, op))], group: [] };
    }
    case "resume": {
      const t = await store.coupleTransition(couple.id, "resume", userId);
      if (t.ok) return { dm: [await say("state.resumed")], group: ["state.resumed"] };
      return { dm: [await say(refusalKey(t, op))], group: [] };
    }
    default:
      return { dm: [], group: [] };
  }
}
