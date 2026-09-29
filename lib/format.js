// Shape of outgoing messages (DR1, DR2, DR17, DR18, R29). Only HTML strings
// and Bot API parameters, no network.
//
// Bilingual message (DR1):
//   <b>Question for María · ES</b>      ← the addressee's language first, with a label
//   ¿Qué te dolió más?
//   <blockquote expandable>RU ▸ Что задело тебя больше всего?</blockquote>
// If the couple shares one language: no labels and no duplicate. In a private chat, only the reader's language.
//
// Splitting (R29): Telegram's limit is 4096 characters of text. We measure the HTML
// after escaping; it's never shorter than the visible text, so the estimate is safe.
//   helper's reply ─▶ first part (+ translations while they fit)
//   extra translations ─▶ separate messages, each a reply to its own message
//   a translation longer than the limit on its own ─▶ a .txt file as a reply

import { escapeHtml, MAX_MESSAGE_CHARS } from "./telegram.js";

export const BUTTON_MAX_CHARS = 24;
export const CALLBACK_DATA_MAX_BYTES = 64;

export class FormatError extends Error {}

export const langLabel = (lang) => String(lang).split(/[-_]/)[0].toUpperCase();

/**
 * @param {object} message
 * @param {{lang: string, text: string}} message.primary the addressee's language
 * @param {{lang: string, text: string}} [message.secondary] the couple's second language
 * @param {string} [message.heading] e.g. "Question for María"
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

// Translation of the partner's message: a collapsed quote with a language label (DR2, DR9).
export function translationBlock({ lang, text }) {
  return `<blockquote expandable>${langLabel(lang)} ▸ ${escapeHtml(text)}</blockquote>`;
}

// --- Notifications (DR18) ---

// With sound: the helper's reply with an addressee, /check steps, the crisis branch.
const SILENT_KINDS = new Set(["translation", "recap", "status", "quota"]);

export function notification(kind) {
  if (!SILENT_KINDS.has(kind) && !["mediator", "check", "crisis", "dm"].includes(kind)) {
    throw new FormatError(`неизвестный вид сообщения: ${kind}`);
  }
  return SILENT_KINDS.has(kind) ? { disable_notification: true } : {};
}

// --- Buttons (DR17) ---

function callbackData(data) {
  if (Buffer.byteLength(data, "utf8") > CALLBACK_DATA_MAX_BYTES) {
    throw new FormatError(`callback_data длиннее ${CALLBACK_DATA_MAX_BYTES} байт: ${data}`);
  }
  return data;
}

// How many buttons fit in a row on a phone without labels being cut to "…".
const ROW_MAX_BUTTONS = 3;
const ROW_MAX_CHARS = 30;

/**
 * Inline keyboard. In the group, labels are bilingual "Слово · Palabra"; if any
 * label is longer than 24 characters, every button gets its own row. Otherwise
 * buttons go in rows of at most 3 and at most 30 label characters.
 * ownRow: true puts a button on its own row (e.g. "Another language" under the list).
 * @param {Array<{labels: string[], data?: string, url?: string, ownRow?: boolean}>} buttons
 *   labels: labels in the languages to show (1 in a private chat, 1–2 in the group)
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
  let closed = false;
  rendered.forEach((button, i) => {
    const row = rows.at(-1);
    const width = row ? row.reduce((sum, b) => sum + b.text.length, 0) : 0;
    const fits = row && !closed && row.length < ROW_MAX_BUTTONS && width + button.text.length <= ROW_MAX_CHARS;
    if (fits && !buttons[i].ownRow) row.push(button);
    else rows.push([button]);
    closed = Boolean(buttons[i].ownRow);
  });
  return { inline_keyboard: rows };
}

// --- Splitting the pause reply (R29) ---

const SEPARATOR = "\n\n";

function documentPart({ chatId, messageId, lang, text }) {
  const form = { chat_id: chatId, filename: `translation-${langLabel(lang).toLowerCase()}.txt`, content: text };
  if (messageId) form.reply_to = messageId;
  return { method: "sendDocument", document: form, ...notification("translation") };
}

/**
 * Parts of the pause reply, in sending order.
 * @param {object} input
 * @param {number} input.chatId
 * @param {string|null} input.replyHtml the helper's reply (ready bilingual HTML) or null when speak=false
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

// A part from pauseMessages → arguments for telegram.send / deliver.
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
