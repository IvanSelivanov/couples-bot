// Онбординг группы и контроль состава (R17; D18, D5).
//
// Бот обязан быть администратором группы: админ получает все сообщения
// группы независимо от privacy mode и может надёжно видеть состав через
// getChatMember. Удалять и банить боту не нужно — прав сверх статуса не просим.
//
// Состав: в группе ровно трое — бот и двое участников пары. Третий человек
// или потеря админки → пара suspended, бот объясняет и молчит; состав
// восстановлен → restore. Изменения состава видны по служебным сообщениям
// (new_chat_members, left_chat_member) и по my_chat_member для самого бота.
//
// getMe.can_read_all_group_messages больше не блокирует регистрацию (R17
// заменил D5): только строка диагностики в логе.
//
// Первое сообщение, согласия и статус (DR7, DR8) — в следующих задачах.

import { createHmac } from "node:crypto";
import { call, escapeHtml } from "./telegram.js";
import * as db from "./db.js";
import { coupleTransition } from "./db.js";
import { text as copyText } from "./copy.js";
import { bilingual, keyboard } from "./format.js";

const PRESENT = new Set(["creator", "administrator", "member", "restricted"]);

/**
 * Готова ли группа: бот — админ, в группе ровно пара и бот.
 * @param {number} chatId
 * @param {number[]} memberIds user_id участников пары, которые уже известны (0–2)
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

// Эффект для пользователя: ключ текста из таблицы состояний DR3.
const SUSPEND_TEXT_KEY = {
  not_admin: "state.suspended_not_admin",
  wrong_count: "state.suspended_third_member",
  member_missing: "state.suspended_third_member",
};

/**
 * Перепроверка состава после события в группе. Возвращает эффекты.
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

// Апдейт меняет состав группы или права бота — нужна перепроверка.
export function affectsComposition(update) {
  const message = update.message;
  if (message?.new_chat_members?.length || message?.left_chat_member) return true;
  return update.my_chat_member !== undefined;
}

// --- Онбординг пары (DR7, DR8, DR5) ---
//
//   /start в группе ─▶ бот админ? ─ нет ─▶ просьба о правах (DR8)
//                    ─▶ ровно трое? ─ нет ─▶ «только вы двое и я»
//                    ─▶ пара onboarding, вызвавший — участник
//                    ─▶ приветствие + кнопка «Открыть бота» (подписанная ссылка) + закреплённый статус
//   личка /start g<id>_<подпись> ─▶ в группе? ─▶ join_couple (не больше двоих)
//                    ─▶ язык ─▶ страна ─▶ время ─▶ согласие (DR7)
//   второе согласие ─▶ пара active ─▶ «Всё готово» в группе, статус ✅ ✅
//
// Именных кнопок для обоих (DR8) нет: Bot API не отдаёт список участников
// группы, и id второго становится известен, только когда он откроет бота.
// Поэтому кнопка одна, а статус дописывает имя, как только партнёр появится.

// Языки на кнопках: подсказка Telegram первой (DR8), дальше частые.
const LANG_CHOICES = ["ru", "en", "es", "de", "fr", "it", "pt", "uk"];
// Вероятные страны по языку — кнопки; остальные вводятся текстом.
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
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) throw new Error("WEBHOOK_SECRET не задан: он подписывает ссылки приглашения");
  return secret;
}

// Параметр deep link: только [A-Za-z0-9_-], до 64 символов.
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

export function languageKeyboard(hint) {
  const codes = [...new Set([baseLang(hint), ...LANG_CHOICES])].filter(Boolean).slice(0, 8);
  return keyboard(
    codes.map((code) => {
      const own = new Intl.DisplayNames([code], { type: "language" }).of(code) ?? code;
      return { labels: [own.charAt(0).toUpperCase() + own.slice(1)], data: `ob:lang:${code}` };
    }),
  );
}

export function countryKeyboard(lang, otherLabel) {
  const names = new Intl.DisplayNames([lang], { type: "region" });
  const buttons = (LANG_COUNTRIES[lang] ?? []).map((code) => ({ labels: [names.of(code) ?? code], data: `ob:country:${code}` }));
  buttons.push({ labels: [otherLabel], data: "ob:country:other" });
  return keyboard(buttons);
}

// Название страны на любом из известных языков → ISO-код. Без модели.
// Устаревшие и служебные коды Intl называет так же, как нынешние страны
// (DD → «Germany»), поэтому их пропускаем.
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

// «14:30» и текущее UTC-время → смещение пояса «+03:00», шаг 15 минут.
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

// Закреплённый статус: «✅ Иван · ⏳ María», для неизвестного партнёра — «⏳ …».
export function statusLine(members) {
  const parts = members.map((m) => `${m.consentedAt ? "✅" : "⏳"} ${m.name ?? "…"}`);
  if (parts.length < 2) parts.push("⏳ …");
  return parts.join(" · ");
}

async function consentMessage(lang, textFn) {
  // Пункты каталога содержат <b>; имя администратора — внешнее, экранируем.
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
 * Шаг онбординга в личке. Возвращает сообщения для отправки: [{ text, reply_markup? }].
 * @param {object} member строка members (onboarding_step, lang, …)
 * @param {object} input { callback: "lang:ru" | "country:ES" | "country:other" | "consent:yes" | "consent:no", text }
 */
export async function onboardingStep(member, input, { store = db, textFn = copyText, now = Date.now() } = {}) {
  const lang = baseLang(member.lang);
  const say = async (key, params) => textFn(lang, key, params);
  const [kind, value] = String(input.callback ?? "").split(":");

  switch (member.onboarding_step) {
    case "lang": {
      if (kind !== "lang") return [{ text: await say("onboarding.pick_language"), reply_markup: languageKeyboard(member.lang) }];
      await store.memberUpdate(member.user_id, { lang: value, onboarding_step: "country" });
      return [{ text: await textFn(value, "onboarding.pick_country"), reply_markup: countryKeyboard(value, await textFn(value, "onboarding.other_country_button")) }];
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
        // Отказ не оставляет следов в группе (DR7).
        await store.memberUpdate(member.user_id, { onboarding_step: "declined" });
        return [{ text: await say("onboarding.declined") }];
      }
      const r = await store.giveConsent(member.user_id);
      return [{ text: "✅", effect: r.activated ? "activated" : "consented", coupleId: r.coupleId }];
    }
    case "declined": {
      // Передумал: /start снова — снова вопрос согласия.
      await store.memberUpdate(member.user_id, { onboarding_step: "consent" });
      return [await consentMessage(lang, textFn)];
    }
    default:
      return [];
  }
}

/** Текст «Всё готово» для группы: оба языка, три примера (DR8). */
export async function readyHtml(langs, textFn = copyText) {
  const [a, b] = langs;
  const block = async (lang) =>
    [await textFn(lang, "onboarding.ready"), ...(await Promise.all([1, 2, 3].map((n) => textFn(lang, `onboarding.ready_example_${n}`))))].join("\n");
  return bilingual({ primary: { lang: a, text: await block(a) }, secondary: b ? { lang: b, text: await block(b) } : undefined });
}
