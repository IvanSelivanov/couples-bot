// Safety: the help pack and the reaction to crisis / abuse signals
// (design doc "Safety"; DR14, DR18, DR20, DR21).
//
// The crisis branch doesn't call the model: the help pack is assembled from the
// per-country number cache (help_lines) and a static fallback. The cache is filled
// ahead of time, during onboarding and by a monthly cron (decided 2026-09-28).
//
//   filling the cache: the model proposes {name, number, source}
//                     ─▶ the bot loads the source page itself
//                     ─▶ are the number's digits on the page? ─ no ─▶ drop it
//                     ─▶ help_lines[country] = verified rows
//
//   signal in the group / Guest Mode (DR21):
//     abuse  ─▶ group flag ─▶ the same pack to both private chats ─▶ a neutral line in the group
//     crisis ─▶ crisis transition (window and /check stop) ─▶ pack to both ─▶ line + emergency number in the group
//   signal in X's private chat:
//     abuse  ─▶ flag dm:X ─▶ pack to X only; the group and Y get nothing
//     crisis ─▶ pack to X only
//   delivery failure (403 etc.) ─▶ log only: neither the group nor the other partner learns about it

import * as db from "./db.js";
import { generate } from "./gemini.js";
import { text as copyText } from "./copy.js";
import { escapeHtml, deliver } from "./telegram.js";
import { notification } from "./format.js";

// Emergency numbers are static facts, no model needed. Only countries where
// the number is known for sure; for the rest, the findahelpline.com directory.
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

// --- Filling the cache (never during a crisis) ---

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

// The source page must contain the number's digits. We load it ourselves: we don't
// take the model's word for it. https only, short timeout, limited size.
export async function pageHasNumber(url, phone, { fetchFn = fetch } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  // The link was proposed by the model: no IP addresses and no internal hostnames.
  const host = parsed.hostname;
  if (host === "localhost" || /^[\d.]+$/.test(host) || host.includes(":") || !host.includes(".")) return false;
  const want = digits(phone);
  if (want.length < 3) return false;
  try {
    const response = await fetchFn(parsed, { redirect: "follow", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return false;
    const body = (await response.text()).slice(0, 2_000_000);
    // Pages write numbers with various separators: compare digits only, and only
    // as a whole number; a partial match catches random numbers.
    const pageDigits = digits(body.replace(/<[^>]+>/g, " "));
    return pageDigits.includes(want);
  } catch {
    return false;
  }
}

/**
 * Finds and verifies numbers for a country, writes them to the cache. Returns the verified rows.
 * A model failure or no verified number means status failed with no rows:
 * the help pack then relies on the emergency number and the directory.
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

// --- Help pack (no model) ---

/**
 * The same text for both partners (DR21): the couple's languages, rows for all their
 * countries, a neutral first line (DR18). Says nothing about the reason.
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

// Emergency number line for the group on crisis.
export function emergencyLine(countries) {
  const numbers = [...new Set(countries.map((c) => EMERGENCY_NUMBERS[c]).filter(Boolean))];
  return numbers.length ? `SOS: ${numbers.join(" / ")}` : `SOS: ${HELPLINE_DIRECTORY}`;
}

// --- Reacting to a signal ---

const baseLang = (lang) => String(lang ?? "en").split(/[-_]/)[0].toLowerCase();

/**
 * @param {object} input
 * @param {"crisis"|"abuse"} input.signal
 * @param {"group"|"guest"|"dm"} input.surface
 * @param {object} input.context group context (members, coupleId, groupChatId)
 * @param {number} [input.windowId]
 * @param {number} [input.fromUserId] author of the signal for surface = dm
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

  // A chat with a third person (unconfirmed Guest Mode): no couple flag is set.
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
    // A delivery failure is shown to no one: neither the group nor the other partner (DR21).
    if (r.status === "failed" || r.status === "unknown") console.warn(`[safety] набор не доставлен: ${r.status}`);
  }

  // Private chat: the group doesn't find out. Guest Mode: the caller gives a neutral
  // answer in the chat itself via answerGuestQuery; nothing goes to the group.
  if (surface === "dm" || surface === "guest") return { delivered: recipients.length };

  // In the group: a line that doesn't claim delivery (DR21).
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
