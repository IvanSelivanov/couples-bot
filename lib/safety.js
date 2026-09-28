// Безопасность: набор помощи и реакция на сигналы crisis / abuse
// (дизайн-док «Безопасность»; DR14, DR18, DR20, DR21).
//
// Кризисная ветка не зовёт модель: набор помощи собирается из кеша номеров
// по странам (help_lines) и статического запасного варианта. Кеш наполняется
// заранее — на онбординге и ежемесячным cron (решение пользователя 2026-09-28).
//
//   наполнение кеша:  модель предлагает {название, номер, источник}
//                     ─▶ бот сам загружает страницу источника
//                     ─▶ цифры номера на странице есть? ─ нет ─▶ отбросить
//                     ─▶ help_lines[страна] = проверенные строки
//
//   сигнал в группе / Guest Mode (DR21):
//     abuse  ─▶ флаг group ─▶ один и тот же набор в обе лички ─▶ нейтральная строка в группе
//     crisis ─▶ переход crisis (окно и /check стоп) ─▶ набор обоим ─▶ строка + экстренный номер в группе
//   сигнал в личке X:
//     abuse  ─▶ флаг dm:X ─▶ набор только X; группа и Y ничего не получают
//     crisis ─▶ набор только X
//   сбой доставки (403 и т.п.) ─▶ только лог: ни группа, ни второй партнёр не узнают

import * as db from "./db.js";
import { generate } from "./gemini.js";
import { text as copyText } from "./copy.js";
import { escapeHtml, deliver } from "./telegram.js";
import { notification } from "./format.js";

// Экстренные номера — статические факты, модель не нужна. Только страны, в
// которых номер известен твёрдо; для остальных — каталог findahelpline.com.
const EU_112 = "AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE IS NO LI CH".split(" ");
export const EMERGENCY_NUMBERS = {
  ...Object.fromEntries(EU_112.map((c) => [c, "112"])),
  GB: "999",
  US: "911",
  CA: "911",
  AU: "000",
  NZ: "111",
  RU: "112",
  UA: "112",
  TR: "112",
};
export const HELPLINE_DIRECTORY = "https://findahelpline.com";

export const HELP_KINDS = ["mental_health", "domestic_violence", "anger"];

// --- Наполнение кеша (не в момент кризиса) ---

const HELP_SYSTEM = `You list official, currently operating helplines for one country.
Return JSON {"lines": [{"kind", "name", "phone", "source_url"}]} with at most 2 lines per kind:
- kind "mental_health": emotional support / crisis / suicide prevention line;
- kind "domestic_violence": support line for people experiencing violence in a relationship;
- kind "anger": service for people who want help with their own anger or violent behaviour (only if one exists).
Rules: only services you are confident exist; phone exactly as dialled in that country; source_url must be the service's own official page (https) where this phone number is written. If unsure, omit the line. Never invent.`;

const HELP_SCHEMA = {
  type: "OBJECT",
  properties: {
    lines: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          kind: { type: "STRING", enum: HELP_KINDS },
          name: { type: "STRING" },
          phone: { type: "STRING" },
          source_url: { type: "STRING" },
        },
        required: ["kind", "name", "phone", "source_url"],
      },
    },
  },
  required: ["lines"],
};

const digits = (s) => String(s).replace(/\D/g, "");

// Страница источника должна содержать цифры номера. Загружаем сами: модели
// на слово не верим. Только https, короткий таймаут, ограниченный объём.
export async function pageHasNumber(url, phone, { fetchFn = fetch } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  // Ссылку предложила модель: не ходим по IP-адресам и во внутренние имена.
  const host = parsed.hostname;
  if (host === "localhost" || /^[\d.]+$/.test(host) || host.includes(":") || !host.includes(".")) return false;
  const want = digits(phone);
  if (want.length < 3) return false;
  try {
    const response = await fetchFn(parsed, { redirect: "follow", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return false;
    const body = (await response.text()).slice(0, 2_000_000);
    // Номера на страницах пишут с разными разделителями: сравниваем только
    // цифры и только полностью — частичное совпадение ловит случайные числа.
    const pageDigits = digits(body.replace(/<[^>]+>/g, " "));
    return pageDigits.includes(want);
  } catch {
    return false;
  }
}

/**
 * Находит и проверяет номера для страны, пишет в кеш. Возвращает проверенные строки.
 * Сбой модели или ни одного проверенного номера — status failed, строки пустые:
 * набор помощи тогда держится на экстренном номере и каталоге.
 */
export async function refreshHelpLines(country, { store = db, generateFn = generate, fetchFn = fetch } = {}) {
  const result = await generateFn({
    purpose: "help_lines",
    system: HELP_SYSTEM,
    parts: [{ text: `Country (ISO 3166-1 alpha-2): ${country}` }],
    schema: HELP_SCHEMA,
  });
  if (!result.ok) {
    await store.helpLinesPut(country, [], "failed");
    return [];
  }

  const candidates = (result.data.lines ?? []).filter((l) => HELP_KINDS.includes(l.kind) && l.name && l.phone && l.source_url);
  const checks = await Promise.all(candidates.map((l) => pageHasNumber(l.source_url, l.phone, { fetchFn })));
  const verified = candidates
    .filter((_, i) => checks[i])
    .map(({ kind, name, phone, source_url }) => ({ kind, name: String(name).slice(0, 120), phone: String(phone).slice(0, 32), source_url }));

  await store.helpLinesPut(country, verified, verified.length ? "ok" : "failed");
  return verified;
}

// --- Набор помощи (без модели) ---

/**
 * Один и тот же текст для обоих партнёров (DR21): языки пары, строки всех их
 * стран, нейтральная первая строка (DR18). Ничего не говорит о причине.
 * @param {{langs: string[], countries: string[], cached: Array<{country, lines}>}} input
 */
export async function helpPack({ langs, countries, cached }, { textFn = copyText } = {}) {
  const [first, second] = langs;
  const line = async (key) => {
    const a = await textFn(first, key);
    const b = second && second !== first ? await textFn(second, key) : null;
    return b ? `${escapeHtml(a)}\n${escapeHtml(b)}` : escapeHtml(a);
  };

  const out = [`<b>${await line("safety.neutral_first_line")}</b>`, "", await line("safety.pack_intro"), ""];
  for (const country of countries) {
    const entry = cached.find((c) => c.country === country);
    const lines = entry?.lines ?? [];
    for (const kind of HELP_KINDS) {
      for (const l of lines.filter((x) => x.kind === kind)) out.push(`${escapeHtml(l.name)} (${country}): ${escapeHtml(l.phone)}`);
    }
    if (EMERGENCY_NUMBERS[country]) out.push(`${country}: ${EMERGENCY_NUMBERS[country]}`);
  }
  out.push(HELPLINE_DIRECTORY);
  return out.join("\n");
}

export async function buildHelpPack(coupleId, langs, { store = db, textFn = copyText } = {}) {
  const countries = await store.coupleCountries(coupleId);
  const cached = await store.helpLinesGet(countries);
  return helpPack({ langs, countries, cached }, { textFn });
}

// Строка экстренного номера для группы при crisis.
export function emergencyLine(countries) {
  const numbers = [...new Set(countries.map((c) => EMERGENCY_NUMBERS[c]).filter(Boolean))];
  return numbers.length ? `SOS: ${numbers.join(" / ")}` : `SOS: ${HELPLINE_DIRECTORY}`;
}

// --- Реакция на сигнал ---

const baseLang = (lang) => String(lang ?? "en").split(/[-_]/)[0].toLowerCase();

/**
 * @param {object} input
 * @param {"crisis"|"abuse"} input.signal
 * @param {"group"|"guest"|"dm"} input.surface
 * @param {object} input.context групповой контекст (members, coupleId, groupChatId)
 * @param {number} [input.windowId]
 * @param {number} [input.fromUserId] автор сигнала для surface = dm
 */
export async function handleSignal({ signal, surface, context, windowId, fromUserId, noFlag = false }, deps = {}) {
  const store = deps.store ?? db;
  const textFn = deps.text ?? copyText;
  const deliverFn = deps.deliver ?? deliver;
  const coupleId = context.coupleId;
  const langs = [...new Set(context.members.map((m) => baseLang(m.lang)))];
  const signalKey = `${surface}:${windowId ?? "dm"}:${signal}`;

  const recipients = surface === "dm" ? context.members.filter((m) => m.userId === fromUserId) : context.members;
  const packLangs = surface === "dm" ? [baseLang(recipients[0]?.lang)] : langs;

  // Чат с третьим (неподтверждённый Guest Mode): флаг пары не ставится.
  if (signal === "abuse" && !noFlag) await store.addAbuseFlag(coupleId, surface === "dm" ? `dm:${fromUserId}` : "group");
  if (signal === "crisis" && surface !== "dm") await store.coupleTransition(coupleId, "crisis");

  const pack = await buildHelpPack(coupleId, packLangs, { store, textFn });
  for (const member of recipients) {
    const r = await deliverFn(
      {
        key: `safety:${signalKey}:${member.userId}`,
        scope: "dm",
        coupleId,
        chatId: member.userId,
        method: "sendMessage",
        params: { chat_id: member.userId, text: pack, parse_mode: "HTML", ...notification("crisis") },
      },
      { store },
    );
    // Сбой доставки никому не показывается: ни группе, ни второму партнёру (DR21).
    if (r.status === "failed" || r.status === "unknown") console.warn(`[safety] набор не доставлен: ${r.status}`);
  }

  // Личка: группа не узнаёт. Guest Mode: нейтральный ответ в сам чат даёт
  // вызывающий через answerGuestQuery, в группу ничего не пишем.
  if (surface === "dm" || surface === "guest") return { delivered: recipients.length };

  // В группе — строка, которая не утверждает доставку (DR21).
  const [a, b] = await Promise.all(langs.slice(0, 2).map((l) => textFn(l, "safety.group_line")));
  let groupText = b && b !== a ? `${escapeHtml(a)}\n${escapeHtml(b)}` : escapeHtml(a);
  if (signal === "crisis") groupText += `\n${escapeHtml(emergencyLine(await store.coupleCountries(coupleId)))}`;
  await deliverFn(
    {
      key: `safety:${signalKey}:group`,
      scope: "group",
      coupleId,
      chatId: context.groupChatId,
      method: "sendMessage",
      params: { chat_id: context.groupChatId, text: groupText, parse_mode: "HTML", ...notification("crisis") },
    },
    { store },
  );
  return { delivered: recipients.length };
}
