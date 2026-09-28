// Фиксированные тексты на языке собеседника (DR15, R23, DR24).
//
//   ru, en ─▶ каталог lib/copy/*.js, без модели
//   другой ─▶ copy_cache (язык, ключ) ─ source_hash совпал ─▶ текст из кеша
//                   │ нет строки / хеш не совпал
//                   ▼
//             машинный перевод английского исходника (gemini, copy_translate)
//                   ├ ok  ─▶ в кеш с новым хешем; вычитанный ранее ключ → stale (R23)
//                   └ сбой ─▶ английский текст (DR15), кеш не трогаем
//
// source_hash — хеш английского исходника: правка базового текста меняет хеш,
// и ключ переводится заново при первом показе (R23).

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

// Подстановка {name}. Отсутствующий параметр — ошибка программиста.
export function fill(template, params = {}) {
  return template.replace(/\{(\w+)\}/g, (_, name) => {
    if (!(name in params)) throw new CopyError(`нет параметра {${name}}`);
    return String(params[name]);
  });
}

function baseLang(lang) {
  return String(lang ?? FALLBACK_LANG).toLowerCase().split(/[-_]/)[0];
}

// Инструкция переводчику: смысл, а не слова; плейсхолдеры и HTML как есть;
// правило рода DR24.
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
  // Перевод, потерявший плейсхолдер, хуже английского оригинала.
  const placeholders = en[key].match(/\{\w+\}/g) ?? [];
  if (!text || placeholders.some((p) => !text.includes(p))) return null;
  return text;
}

/**
 * Текст ключа на языке lang с подстановкой параметров.
 * @param {string} lang код языка (language_code или выбранный на онбординге)
 * @param {string} key ключ из каталога
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

// Все ключи каталога — для проверок и прогрева кеша на онбординге.
export const KEYS = Object.keys(en);
