// Fixed texts in the reader's language (DR15, R23, DR24).
//
//   ru, en ─▶ catalog lib/copy/*.js, no model
//   other  ─▶ copy_cache (lang, key) ─ source_hash matches ─▶ cached text
//                   │ no row / hash mismatch
//                   ▼
//             machine translation of the English source (gemini, copy_translate)
//                   ├ ok      ─▶ into the cache with the new hash; a key read earlier → stale (R23)
//                   └ failure ─▶ English text (DR15), cache untouched
//
// source_hash is a hash of the English source: editing the base text changes the
// hash, and the key is translated again the next time it's shown (R23).

import { createHash } from "node:crypto";
import ru from "./copy/ru.js";
import en from "./copy/en.js";
import * as db from "./db.js";
import { generate } from "./gemini.js";

const CATALOGS = { ru, en };
export const FALLBACK_LANG = "en";

export class CopyError extends Error {}

export function sourceHash(key) {
  const source = en[key];
  if (source === undefined) throw new CopyError(`нет текста: ${key}`);
  return createHash("sha256").update(source).digest("hex").slice(0, 16);
}

// {name} substitution. A missing parameter is a programmer error.
export function fill(template, params = {}) {
  return template.replace(/\{(\w+)\}/g, (_, name) => {
    if (!(name in params)) throw new CopyError(`нет параметра {${name}}`);
    return String(params[name]);
  });
}

function baseLang(lang) {
  return String(lang ?? FALLBACK_LANG).toLowerCase().split(/[-_]/)[0];
}

// Instructions for the translator: meaning, not words; placeholders and HTML
// as is; the DR24 gender rule.
const TRANSLATE_SYSTEM = `You translate short interface texts of a Telegram bot that helps a couple talk.
Rules:
- Translate meaning and tone, not word by word. Warm, plain, no emoji added.
- Keep every placeholder like {name} exactly as is, untranslated.
- Keep HTML tags like <b> exactly as is.
- Address the reader informally (tu/du/ты forms) where the language has that distinction.
- The bot refers to itself with masculine grammatical gender in languages that have it (like the word "bot").
- Button labels (keys ending in _button) must stay at most 24 characters.
Return JSON {"text": "..."} with the translation only.`;

const TRANSLATE_SCHEMA = { type: "OBJECT", properties: { text: { type: "STRING" } }, required: ["text"] };

async function translate(lang, key) {
  const result = await generate({
    purpose: "copy_translate",
    system: TRANSLATE_SYSTEM,
    parts: [{ text: `Target language (BCP-47): ${lang}\nKey: ${key}\nEnglish source:\n${en[key]}` }],
    schema: TRANSLATE_SCHEMA,
  });
  if (!result.ok) return null;
  const text = String(result.data.text ?? "").trim();
  // A translation that lost a placeholder is worse than the English original.
  const placeholders = en[key].match(/\{\w+\}/g) ?? [];
  if (!text || placeholders.some((p) => !text.includes(p))) return null;
  return text;
}

/**
 * Text for a key in language lang, with parameters substituted.
 * @param {string} lang language code (language_code or the one chosen during onboarding)
 * @param {string} key catalog key
 * @param {object} [params]
 */
export async function text(lang, key, params, { store = db, translateFn = translate } = {}) {
  const code = baseLang(lang);
  if (CATALOGS[code]) {
    const template = CATALOGS[code][key] ?? en[key];
    if (template === undefined) throw new CopyError(`нет текста: ${key}`);
    return fill(template, params);
  }

  const hash = sourceHash(key);
  let cached = null;
  try {
    cached = await store.copyCacheGet(code, key);
  } catch (error) {
    console.warn(`[copy] кеш недоступен: ${error.name}`);
  }
  if (cached && cached.source_hash === hash) return fill(cached.text, params);

  const translated = await translateFn(code, key);
  if (!translated) return fill(en[key], params);

  try {
    await store.copyCachePut({ lang: code, key, text: translated, sourceHash: hash, wasReviewed: Boolean(cached?.reviewed) });
  } catch (error) {
    console.warn(`[copy] не записал кеш: ${error.name}`);
  }
  return fill(translated, params);
}

// All catalog keys, for checks and for warming the cache during onboarding.
export const KEYS = Object.keys(en);
