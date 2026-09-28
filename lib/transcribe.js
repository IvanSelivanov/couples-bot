// Расшифровка голосовых и кружков (DR25, R22, R26). Один вызов модели даёт
// транскрипт, язык, саммари, флаг charged и перевод для партнёра — перевод
// голосового живёт только в сообщении с транскриптом, ответ ведущего его не
// повторяет (R22).
//
// Правила показа (DR25):
//   транскрипт — всегда, в группе и в личке, даже при одном языке пары;
//   саммари — только в группе, голосовое от 60 с, charged = false и квота
//   ниже 70% (R20);
//   длинное — файлом .txt, как в tgbot.

import { download, getFile, escapeHtml, MAX_FILE_BYTES, MAX_MESSAGE_CHARS } from "./telegram.js";
import { generate, VOICE_SUMMARY_CUTOFF } from "./gemini.js";
import { langLabel, notification } from "./format.js";

export const SUMMARY_THRESHOLD_SECONDS = Number(process.env.SUMMARY_THRESHOLD_SECONDS ?? 60);
export const MAX_VOICE_SECONDS = Number(process.env.MAX_VOICE_SECONDS ?? 600);
const VIDEO_MEDIA_RESOLUTION = "MEDIA_RESOLUTION_LOW";

export const MEDIA_KINDS = {
  voice: (media) => media.mime_type ?? "audio/ogg",
  video_note: () => "video/mp4",
};

const SYSTEM = `You transcribe a Telegram voice message or video note sent inside a couple's private chat.
Return JSON:
- transcript: verbatim speech, exactly what was said. Do not smooth speech or drop repetitions. Punctuate and split into paragraphs by meaning. Use [inaudible] instead of guessing. For video notes transcribe speech only, never describe the picture.
- lang: BCP-47 code of the spoken language.
- summary: the gist in 2–3 short lines, what was said, no evaluation and no guesses about feelings or intentions. Write it in the target language.
- charged: true if the message is emotionally loaded (hurt, anger, accusation, fear, tears, conflict), false for everyday logistics.
- translation: meaning-and-tone translation of the transcript into the target language; empty string if the speech is already in the target language.`;

const SCHEMA = {
  type: "OBJECT",
  properties: {
    transcript: { type: "STRING" },
    lang: { type: "STRING" },
    summary: { type: "STRING" },
    charged: { type: "BOOLEAN" },
    translation: { type: "STRING" },
  },
  required: ["transcript", "lang", "summary", "charged", "translation"],
};

export async function fetchMedia(fileId, { deadline } = {}) {
  const file = await getFile(fileId, { deadline });
  if (file.file_size && file.file_size > MAX_FILE_BYTES) throw new Error("файл больше 20 МБ");
  return download(file.file_path, { deadline });
}

/**
 * @param {object} input
 * @param {Buffer} input.bytes
 * @param {string} input.mimeType
 * @param {"group"|"dm"} input.surface уровень квоты: группа 90%, личка 100%
 * @param {string} input.targetLang язык, на который переводить и писать саммари
 * @returns {Promise<{ok: true, transcript, lang, summary, charged, translation, usage} | {blocked} | {unavailable}>}
 */
export async function transcribeMedia({ bytes, mimeType, surface, targetLang, deadline }, { generateFn = generate } = {}) {
  const result = await generateFn({
    purpose: surface === "dm" ? "transcribe_dm" : "transcribe_group",
    system: SYSTEM,
    parts: [
      { text: `Target language (BCP-47): ${targetLang}` },
      { inline_data: { mime_type: mimeType, data: bytes.toString("base64") } },
    ],
    schema: SCHEMA,
    mediaResolution: mimeType.startsWith("video/") ? VIDEO_MEDIA_RESOLUTION : undefined,
    timeoutMs: 120_000,
    deadline,
  });
  if (!result.ok) return result;

  const d = result.data;
  const transcript = String(d.transcript ?? "").trim();
  if (!transcript) return { unavailable: "error", reason: "empty" };
  return {
    ok: true,
    transcript,
    lang: String(d.lang ?? "").trim() || null,
    summary: String(d.summary ?? "").trim(),
    charged: Boolean(d.charged),
    translation: String(d.translation ?? "").trim(),
    usage: result.usage,
  };
}

// Показывать ли саммари (DR25, R20).
export function showSummary({ surface, durationSeconds, charged, usage, summary }) {
  return (
    surface === "group" &&
    Boolean(summary) &&
    durationSeconds >= SUMMARY_THRESHOLD_SECONDS &&
    !charged &&
    usage * 100 < VOICE_SUMMARY_CUTOFF
  );
}

/**
 * Части ответа с транскриптом, реплаем на голосовое.
 * @param {object} input
 * @param {number} input.chatId
 * @param {number} input.replyTo message_id голосового
 * @param {object} input.result результат transcribeMedia
 * @param {string} input.targetLang
 * @param {string} input.summaryLabel подпись саммари на языке группы («Кратко»)
 * @param {string} input.fileNotice текст «прикладываю файлом»
 */
export function transcriptParts({ chatId, replyTo, result, surface, durationSeconds, targetLang, summaryLabel, fileNotice, limit = MAX_MESSAGE_CHARS }) {
  const withSummary = showSummary({ surface, durationSeconds, ...result });
  const head = withSummary ? `<b>${escapeHtml(summaryLabel)}</b>\n${escapeHtml(result.summary)}\n\n` : "";
  const transcriptBlock = `<blockquote expandable>${langLabel(result.lang ?? "")} ▸ ${escapeHtml(result.transcript)}</blockquote>`;
  const translationBlock = result.translation
    ? `\n<blockquote expandable>${langLabel(targetLang)} ▸ ${escapeHtml(result.translation)}</blockquote>`
    : "";
  const silent = surface === "group" ? notification("translation") : {};
  const reply = { reply_parameters: { message_id: replyTo } };

  const whole = head + transcriptBlock + translationBlock;
  if (whole.length <= limit) {
    return [{ method: "sendMessage", params: { chat_id: chatId, text: whole, parse_mode: "HTML", ...reply, ...silent } }];
  }

  // Длинное: короткое сообщение (саммари или пометка), затем файлы.
  const parts = [
    {
      method: "sendMessage",
      params: { chat_id: chatId, text: head ? head.trim() : escapeHtml(fileNotice), parse_mode: "HTML", ...reply, ...silent },
    },
    {
      method: "sendDocument",
      document: { chat_id: chatId, filename: `transcript-${langLabel(result.lang ?? "xx").toLowerCase()}.txt`, content: result.transcript, reply_to: replyTo },
      ...silent,
    },
  ];
  if (result.translation) {
    parts.push({
      method: "sendDocument",
      document: { chat_id: chatId, filename: `translation-${langLabel(targetLang).toLowerCase()}.txt`, content: result.translation, reply_to: replyTo },
      ...silent,
    });
  }
  return parts;
}
