// Transcription of voice messages and video notes (DR25, R22, R26). One model call
// returns the transcript, language, summary, a charged flag and a translation for
// the partner. The voice translation lives only in the transcript message; the
// helper's reply doesn't repeat it (R22).
//
// Display rules (DR25):
//   transcript — always, in the group and in private chats, even if the couple shares a language;
//   summary — group only, voice of 60 s or longer, charged = false and quota
//   below 70% (R20);
//   long text — as a .txt file, like in tgbot.

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

export const TRANSCRIBE_SYSTEM = `You transcribe a Telegram voice message or video note sent inside a couple's private chat.
Return JSON:
- transcript: verbatim speech, exactly what was said. Do not smooth speech or drop repetitions. Punctuate and split into paragraphs by meaning. Use [inaudible] instead of guessing. For video notes transcribe speech only, never describe the picture.
- lang: BCP-47 code of the spoken language.
- summary: the gist in 2–3 short lines, what was said, no evaluation and no guesses about feelings or intentions. Write it in the target language.
- charged: true if the message is emotionally loaded (hurt, anger, accusation, fear, tears, conflict), false for everyday logistics.
- translation: meaning-and-tone translation of the transcript into the target language; empty string if the speech is already in the target language.`;

export const TRANSCRIBE_SCHEMA = {
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
 * @param {"group"|"dm"} input.surface quota tier: group 90%, private chat 100%
 * @param {string} input.targetLang language to translate into and to write the summary in
 * @returns {Promise<{ok: true, transcript, lang, summary, charged, translation, usage} | {blocked} | {unavailable}>}
 */
export async function transcribeMedia({ bytes, mimeType, surface, targetLang, deadline }, { generateFn = generate } = {}) {
  const result = await generateFn({
    purpose: surface === "dm" ? "transcribe_dm" : "transcribe_group",
    system: TRANSCRIBE_SYSTEM,
    parts: [
      { text: `Target language (BCP-47): ${targetLang}` },
      { inline_data: { mime_type: mimeType, data: bytes.toString("base64") } },
    ],
    schema: TRANSCRIBE_SCHEMA,
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

// Whether to show the summary (DR25, R20).
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
 * Parts of the transcript reply, sent as a reply to the voice message.
 * @param {object} input
 * @param {number} input.chatId
 * @param {number} input.replyTo message_id of the voice message
 * @param {object} input.result result of transcribeMedia
 * @param {string} input.targetLang
 * @param {string} input.summaryLabel summary label in the group's language ("In short")
 * @param {string} input.fileNotice the "attaching as a file" text
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

  // Long: a short message (summary or a note), then the files.
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
