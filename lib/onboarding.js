// Group onboarding and membership control (R17; D18, D5).
//
// The bot must be a group admin: an admin receives all group messages
// regardless of privacy mode and can reliably check membership via
// getChatMember. The bot doesn't need to delete or ban, so we ask for no rights beyond the status.
//
// Membership: exactly three in the group, the bot and the two partners. A third person
// or losing admin → the couple is suspended, the bot explains and goes quiet; membership
// restored → restore. Membership changes show up as service messages
// (new_chat_members, left_chat_member) and as my_chat_member for the bot itself.
//
// getMe.can_read_all_group_messages no longer blocks registration (R17
// replaced D5): it's just a diagnostic log line.
//
// First message, consent and status (DR7, DR8) are in later tasks.

import { createHmac } from "node:crypto";
import { call, escapeHtml } from "./telegram.js";
import * as db from "./db.js";
import { coupleTransition } from "./db.js";
import { text as copyText } from "./copy.js";
import { bilingual, keyboard } from "./format.js";
import { webhookSecret } from "./crypto.js";

const PRESENT = new Set(["creator", "administrator", "member", "restricted"]);

/**
 * Is the group ready: the bot is an admin, the group has exactly the couple and the bot.
 * @param {number} chatId
 * @param {number[]} memberIds user_ids of the couple's members already known (0–2)
 * @returns {Promise<{ok: true} | {ok: false, reason: "not_admin"|"wrong_count"|"member_missing", count?: number}>}
 */
export async function checkGroup(chatId, memberIds, { api = call } = {}) {
  const me = await api("getMe", {});
  if (me.can_read_all_group_messages !== true) {
    console.warn("[onboarding] privacy mode включён; бот-админ всё равно видит все сообщения");
  }

  const botMember = await api("getChatMember", { chat_id: chatId, user_id: me.id });
  if (botMember.status !== "administrator") return { ok: false, reason: "not_admin" };

  const count = await api("getChatMemberCount", { chat_id: chatId });
  if (count !== 3) return { ok: false, reason: "wrong_count", count };

  for (const userId of memberIds) {
    const member = await api("getChatMember", { chat_id: chatId, user_id: userId });
    if (!PRESENT.has(member.status)) return { ok: false, reason: "member_missing" };
  }
  return { ok: true };
}

// Effect for the user: text key from the DR3 state table.
const SUSPEND_TEXT_KEY = {
  not_admin: "state.suspended_not_admin",
  wrong_count: "state.suspended_third_member",
  member_missing: "state.suspended_third_member",
};

/**
 * Rechecks membership after a group event. Returns effects.
 * @param {object} couple { id, groupChatId, state, memberIds }
 */
export async function recheckComposition(couple, { api = call, transition = coupleTransition } = {}) {
  const result = await checkGroup(couple.groupChatId, couple.memberIds, { api });

  if (!result.ok && (couple.state === "active" || couple.state === "paused")) {
    const t = await transition(couple.id, "suspend");
    return t.ok ? [{ type: "say", key: SUSPEND_TEXT_KEY[result.reason] }] : [];
  }
  if (result.ok && couple.state === "suspended") {
    const t = await transition(couple.id, "restore");
    return t.ok ? [{ type: "say", key: "state.restored", to: t.to }] : [];
  }
  return [];
}

// The update changes group membership or the bot's rights, so a recheck is needed.
export function affectsComposition(update) {
  const message = update.message;
  if (message?.new_chat_members?.length || message?.left_chat_member) return true;
  return update.my_chat_member !== undefined;
}

// --- Couple onboarding (DR7, DR8, DR5) ---
//
//   /start in the group ─▶ bot is admin? ─ no ─▶ ask for rights (DR8)
//                    ─▶ exactly three? ─ no ─▶ "only the two of you and me"
//                    ─▶ couple onboarding, the caller is a member
//                    ─▶ intro + "Open the bot" button (signed link) + pinned status
//   private /start g<id>_<signature> ─▶ in the group? ─▶ join_couple (at most two)
//                    ─▶ language ─▶ country ─▶ time ─▶ consent (DR7)
//   second consent ─▶ couple active ─▶ "All set" in the group, status ✅ ✅
//
// There are no per-name buttons for both (DR8): the Bot API doesn't list group
// members, and the second partner's id becomes known only once they open the bot.
// So there's one button, and the status adds the name as soon as the partner shows up.

// Language buttons: Telegram's hint first (DR8), then common ones.
const LANG_CHOICES = ["ru", "en", "es", "de", "fr", "it", "pt", "uk"];
// Likely countries per language are buttons; the rest are typed in.
const LANG_COUNTRIES = {
  ru: ["RU", "KZ", "BY", "DE"],
  en: ["US", "GB", "CA", "AU"],
  es: ["ES", "MX", "AR", "CO"],
  de: ["DE", "AT", "CH"],
  fr: ["FR", "BE", "CH", "CA"],
  it: ["IT", "CH"],
  pt: ["PT", "BR"],
  uk: ["UA", "PL", "DE"],
};

const baseLang = (lang) => String(lang ?? "en").split(/[-_]/)[0].toLowerCase();

function inviteSecret() {
  return webhookSecret();
}

// Deep link parameter: only [A-Za-z0-9_-], up to 64 characters.
export function signInvite(coupleId) {
  const sig = createHmac("sha256", inviteSecret()).update(`invite:${coupleId}`).digest("base64url").slice(0, 16);
  return `g${coupleId}_${sig}`;
}

export function verifyInvite(payload) {
  const match = /^g(\d+)_([A-Za-z0-9_-]{16})$/.exec(String(payload ?? ""));
  if (!match) return null;
  const coupleId = Number(match[1]);
  return signInvite(coupleId) === payload ? coupleId : null;
}

const capitalize = (name) => name.charAt(0).toUpperCase() + name.slice(1);

// The language's own name: "Español", "Українська".
function ownName(code) {
  return capitalize(new Intl.DisplayNames([code], { type: "language" }).of(code) ?? code);
}

export function languageKeyboard(hint, otherLabel) {
  const codes = [...new Set([baseLang(hint), ...LANG_CHOICES])].filter(Boolean).slice(0, 8);
  const buttons = codes.map((code) => ({ labels: [ownName(code)], data: `ob:lang:${code}` }));
  if (otherLabel) buttons.push({ labels: [otherLabel], data: "ob:lang:other", ownRow: true });
  return keyboard(buttons);
}

// All two-letter ISO 639-1 codes that Intl knows as a language.
const ALL_LANGUAGES = (() => {
  const names = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" });
  const codes = [];
  for (let a = 97; a <= 122; a++) {
    for (let b = 97; b <= 122; b++) {
      const code = String.fromCharCode(a, b);
      if (names.of(code)) codes.push(code);
    }
  }
  return codes;
})();

// A language name in the user's language, in English, Russian, Spanish or its own
// name → ISO 639-1 code. No model.
export function parseLanguage(input, langs = ["en"]) {
  const wanted = String(input ?? "").trim().toLowerCase();
  if (!wanted) return null;
  if (ALL_LANGUAGES.includes(wanted)) return wanted;
  for (const lang of [...new Set([...langs, "en", "ru", "es"])]) {
    const names = new Intl.DisplayNames([lang], { type: "language", fallback: "none" });
    const code = ALL_LANGUAGES.find((c) => names.of(c)?.toLowerCase() === wanted);
    if (code) return code;
  }
  return ALL_LANGUAGES.find((c) => ownName(c).toLowerCase() === wanted) ?? null;
}

export function countryKeyboard(lang, otherLabel) {
  const names = new Intl.DisplayNames([lang], { type: "region" });
  const buttons = (LANG_COUNTRIES[lang] ?? []).map((code) => ({ labels: [names.of(code) ?? code], data: `ob:country:${code}` }));
  buttons.push({ labels: [otherLabel], data: "ob:country:other", ownRow: true });
  return keyboard(buttons);
}

// A country name in any of the known languages → ISO code. No model.
// Intl names deprecated and special codes the same as current countries
// (DD → "Germany"), so we skip them.
const NOT_COUNTRIES = new Set(["DD", "FX", "SU", "YU", "ZR", "TP", "BU", "CS", "NT", "AN", "EU", "EZ", "UN", "QO", "ZZ", "XA", "XB", "AA", "QM", "QN", "QP", "QQ", "QR", "QS", "QT", "QU", "QV", "QW", "QX", "QY", "QZ"]);
const ALL_REGIONS = (() => {
  const codes = [];
  for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) codes.push(String.fromCharCode(a, b));
  return codes.filter((c) => !NOT_COUNTRIES.has(c) && !c.startsWith("X"));
})();
export function parseCountry(input, langs = ["en"]) {
  const wanted = String(input ?? "").trim().toLowerCase();
  if (!wanted) return null;
  if (/^[a-z]{2}$/.test(wanted)) return wanted.toUpperCase();
  for (const lang of [...new Set([...langs, "en", "ru", "es"])]) {
    const names = new Intl.DisplayNames([lang], { type: "region", fallback: "none" });
    for (const code of ALL_REGIONS) {
      const name = names.of(code);
      if (name && name.toLowerCase() === wanted) return code;
    }
  }
  return null;
}

// "14:30" and the current UTC time → timezone offset "+03:00", in 15-minute steps.
export function offsetFromLocalTime(input, now = Date.now()) {
  const match = /^\s*(\d{1,2})[:.\s](\d{2})\s*$/.exec(String(input ?? ""));
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  const utc = new Date(now);
  let diff = h * 60 + m - (utc.getUTCHours() * 60 + utc.getUTCMinutes());
  if (diff > 14 * 60) diff -= 24 * 60;
  if (diff < -12 * 60) diff += 24 * 60;
  const rounded = Math.round(diff / 15) * 15;
  const sign = rounded < 0 ? "-" : "+";
  const abs = Math.abs(rounded);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

// Pinned status: "✅ Ivan · ⏳ María", "⏳ …" for a partner not yet known.
export function statusLine(members) {
  const parts = members.map((m) => `${m.consentedAt ? "✅" : "⏳"} ${m.name ?? "…"}`);
  if (parts.length < 2) parts.push("⏳ …");
  return parts.join(" · ");
}

async function consentMessage(lang, textFn) {
  // Catalog items contain <b>; the admin name comes from outside, so escape it.
  const admin = escapeHtml(process.env.ADMIN_NAME ?? "автор проекта");
  const items = await Promise.all([1, 2, 3, 4].map((n) => textFn(lang, `onboarding.consent_${n}`, n === 1 ? { admin } : {})));
  const retention = escapeHtml(await textFn(lang, "onboarding.consent_retention"));
  const title = escapeHtml(await textFn(lang, "onboarding.consent_title"));
  return {
    text: `<b>${title}</b>\n\n${items.map((t, i) => `${i + 1}. ${t}`).join("\n")}\n\n<blockquote expandable>${retention}</blockquote>`,
    reply_markup: keyboard([
      { labels: [await textFn(lang, "onboarding.consent_accept")], data: "ob:consent:yes" },
      { labels: [await textFn(lang, "onboarding.consent_decline")], data: "ob:consent:no" },
    ]),
  };
}

/**
 * An onboarding step in the private chat. Returns messages to send: [{ text, reply_markup? }].
 * @param {object} member members row (onboarding_step, lang, …)
 * @param {object} input { callback: "lang:ru" | "country:ES" | "country:other" | "consent:yes" | "consent:no", text }
 */
export async function onboardingStep(member, input, { store = db, textFn = copyText, now = Date.now() } = {}) {
  const lang = baseLang(member.lang);
  const say = async (key, params) => textFn(lang, key, params);
  const [kind, value] = String(input.callback ?? "").split(":");

  switch (member.onboarding_step) {
    case "lang": {
      if (kind === "lang" && value === "other") return [{ text: await say("onboarding.language_hint") }];
      let chosen = kind === "lang" ? value : null;
      if (!chosen && input.text) {
        chosen = parseLanguage(input.text, [lang]);
        if (!chosen) return [{ text: await say("onboarding.bad_language") }];
      }
      if (!chosen) {
        return [{ text: await say("onboarding.pick_language"), reply_markup: languageKeyboard(member.lang, await say("onboarding.other_language_button")) }];
      }
      await store.memberUpdate(member.user_id, { lang: chosen, onboarding_step: "country" });
      return [{ text: await textFn(chosen, "onboarding.pick_country"), reply_markup: countryKeyboard(chosen, await textFn(chosen, "onboarding.other_country_button")) }];
    }
    case "country": {
      let country = null;
      if (kind === "country" && value === "other") return [{ text: await say("onboarding.country_hint") }];
      if (kind === "country") country = value;
      else if (input.text) country = parseCountry(input.text, [lang]);
      if (!country) return [{ text: await say("onboarding.bad_country") }];
      await store.memberUpdate(member.user_id, { country, onboarding_step: "time" });
      return [{ text: await say("onboarding.ask_time") }];
    }
    case "time": {
      const tz = offsetFromLocalTime(input.text, now);
      if (!tz) return [{ text: await say("onboarding.bad_time") }];
      await store.memberUpdate(member.user_id, { tz, onboarding_step: "consent" });
      return [{ ...(await consentMessage(lang, textFn)), effect: "consent_asked" }];
    }
    case "consent": {
      if (kind !== "consent") return [];
      if (value === "no") {
        // Declining leaves no trace in the group (DR7).
        await store.memberUpdate(member.user_id, { onboarding_step: "declined" });
        return [{ text: await say("onboarding.declined") }];
      }
      const r = await store.giveConsent(member.user_id);
      return [{ text: "✅", effect: r.activated ? "activated" : "consented", coupleId: r.coupleId }];
    }
    case "declined": {
      // Changed their mind: /start again asks for consent again.
      await store.memberUpdate(member.user_id, { onboarding_step: "consent" });
      return [await consentMessage(lang, textFn)];
    }
    default:
      return [];
  }
}

/** The "All set" text for the group: both languages, three examples (DR8). */
export async function readyHtml(langs, textFn = copyText) {
  const [a, b] = langs;
  const block = async (lang) =>
    [await textFn(lang, "onboarding.ready"), ...(await Promise.all([1, 2, 3].map((n) => textFn(lang, `onboarding.ready_example_${n}`))))].join("\n");
  return bilingual({ primary: { lang: a, text: await block(a) }, secondary: b ? { lang: b, text: await block(b) } : undefined });
}
