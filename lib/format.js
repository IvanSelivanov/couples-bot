// Форма исходящих сообщений (DR1, DR2, DR17, DR18, R29). Только HTML-строки
// и параметры Bot API — никакой сети.
//
// Двуязычное сообщение (DR1):
//   <b>Вопрос к Марии · ES</b>          ← язык адресата первым, с меткой
//   ¿Qué te dolió más?
//   <blockquote expandable>RU ▸ Что задело тебя больше всего?</blockquote>
// Один язык у пары — без меток и без дубля. В личке — только язык собеседника.
//
// Разбиение (R29): лимит Telegram 4096 символов текста. Меряем HTML после
// экранирования — он не короче видимого текста, значит оценка с запасом.
//   ответ ведущего ─▶ первая часть (+ переводы, пока влезают)
//   переводы сверх ─▶ отдельные сообщения, каждое реплаем на свою реплику
//   перевод длиннее лимита сам по себе ─▶ файл .txt реплаем на реплику

import { escapeHtml, MAX_MESSAGE_CHARS } from "./telegram.js";

export const BUTTON_MAX_CHARS = 24;
export const CALLBACK_DATA_MAX_BYTES = 64;

export class FormatError extends Error {}

export const langLabel = (lang) => String(lang).split(/[-_]/)[0].toUpperCase();

/**
 * @param {object} message
 * @param {{lang: string, text: string}} message.primary язык адресата
 * @param {{lang: string, text: string}} [message.secondary] второй язык пары
 * @param {string} [message.heading] например «Вопрос к Марии»
 */
export function bilingual({ primary, secondary, heading }) {
  const sameLang = !secondary || langLabel(secondary.lang) === langLabel(primary.lang);
  if (sameLang) {
    const head = heading ? `<b>${escapeHtml(heading)}</b>\n` : "";
    return `${head}${escapeHtml(primary.text)}`;
  }
  const label = heading ? `${heading} · ${langLabel(primary.lang)}` : langLabel(primary.lang);
  return (
    `<b>${escapeHtml(label)}</b>\n${escapeHtml(primary.text)}\n` +
    `<blockquote expandable>${langLabel(secondary.lang)} ▸ ${escapeHtml(secondary.text)}</blockquote>`
  );
}

// Перевод реплики партнёра: свёрнутая цитата с меткой языка (DR2, DR9).
export function translationBlock({ lang, text }) {
  return `<blockquote expandable>${langLabel(lang)} ▸ ${escapeHtml(text)}</blockquote>`;
}

// --- Уведомления (DR18) ---

// Со звуком: ответ ведущего с адресатом, шаги /check, кризисная ветка.
const SILENT_KINDS = new Set(["translation", "recap", "status", "quota"]);

export function notification(kind) {
  if (!SILENT_KINDS.has(kind) && !["mediator", "check", "crisis", "dm"].includes(kind)) {
    throw new FormatError(`неизвестный вид сообщения: ${kind}`);
  }
  return SILENT_KINDS.has(kind) ? { disable_notification: true } : {};
}

// --- Кнопки (DR17) ---

function callbackData(data) {
  if (Buffer.byteLength(data, "utf8") > CALLBACK_DATA_MAX_BYTES) {
    throw new FormatError(`callback_data длиннее ${CALLBACK_DATA_MAX_BYTES} байт: ${data}`);
  }
  return data;
}

// Сколько кнопок помещается в строку на телефоне, не обрезая подписи до «…».
const ROW_MAX_BUTTONS = 3;
const ROW_MAX_CHARS = 30;

/**
 * Инлайн-клавиатура. В группе подпись двуязычная «Слово · Palabra»; если хоть
 * одна подпись длиннее 24 символов — каждая кнопка на своей строке. Иначе
 * кнопки идут строками не больше чем по 3 и не длиннее 30 символов подписей.
 * @param {Array<{labels: string[], data?: string, url?: string}>} buttons
 *   labels — подписи на языках, которые нужно показать (1 в личке, 1–2 в группе)
 */
export function keyboard(buttons) {
  const rendered = buttons.map((b) => {
    const uniq = [...new Set(b.labels)];
    const text = uniq.join(" · ");
    const button = { text };
    if (b.url) button.url = b.url;
    else button.callback_data = callbackData(b.data);
    return button;
  });
  if (rendered.some((b) => b.text.length > BUTTON_MAX_CHARS)) return { inline_keyboard: rendered.map((b) => [b]) };
  const rows = [];
  for (const button of rendered) {
    const row = rows.at(-1);
    const width = row ? row.reduce((sum, b) => sum + b.text.length, 0) : 0;
    if (row && row.length < ROW_MAX_BUTTONS && width + button.text.length <= ROW_MAX_CHARS) row.push(button);
    else rows.push([button]);
  }
  return { inline_keyboard: rows };
}

// --- Разбиение ответа паузы (R29) ---

const SEPARATOR = "\n\n";

function documentPart({ chatId, messageId, lang, text }) {
  const form = { chat_id: chatId, filename: `translation-${langLabel(lang).toLowerCase()}.txt`, content: text };
  if (messageId) form.reply_to = messageId;
  return { method: "sendDocument", document: form, ...notification("translation") };
}

/**
 * Части ответа паузы в порядке отправки.
 * @param {object} input
 * @param {number} input.chatId
 * @param {string|null} input.replyHtml ответ ведущего (готовый bilingual) или null при speak=false
 * @param {Array<{messageId: number, lang: string, text: string}>} input.translations
 * @param {number} [input.limit]
 * @returns {Array<object>} { method: "sendMessage", params } | { method: "sendDocument", document }
 */
export function pauseMessages({ chatId, replyHtml, translations = [], limit = MAX_MESSAGE_CHARS }) {
  const parts = [];
  const blocks = translations.map((t) => ({ ...t, html: translationBlock(t) }));
  let rest = blocks;

  if (replyHtml) {
    if (replyHtml.length > limit) throw new FormatError("ответ ведущего длиннее лимита сообщения");
    let html = replyHtml;
    rest = [];
    for (const block of blocks) {
      if (rest.length === 0 && html.length + SEPARATOR.length + block.html.length <= limit) {
        html += SEPARATOR + block.html;
      } else {
        rest.push(block);
      }
    }
    parts.push({
      method: "sendMessage",
      params: { chat_id: chatId, text: html, parse_mode: "HTML", ...notification("mediator") },
    });
  }

  for (const block of rest) {
    if (block.html.length > limit) {
      parts.push(documentPart({ chatId, ...block }));
      continue;
    }
    const params = { chat_id: chatId, text: block.html, parse_mode: "HTML", ...notification("translation") };
    if (block.messageId) params.reply_parameters = { message_id: block.messageId };
    parts.push({ method: "sendMessage", params });
  }
  return parts;
}

// Часть из pauseMessages → аргументы для telegram.send / deliver.
export function toSendArgs(part) {
  if (part.method === "sendMessage") return { method: "sendMessage", params: part.params };
  const { chat_id, filename, content, reply_to } = part.document;
  const form = new FormData();
  form.set("chat_id", String(chat_id));
  form.set("document", new Blob([content], { type: "text/plain" }), filename);
  if (reply_to) form.set("reply_parameters", JSON.stringify({ message_id: reply_to }));
  if (part.disable_notification) form.set("disable_notification", "true");
  return { method: "sendDocument", params: form };
}
