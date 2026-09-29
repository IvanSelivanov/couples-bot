// Черновики «переводчик со злого» (DR10) и заметки с согласия (DR11, R15).
//
// Черновик:
//   /draft [текст] или кнопка «Сформулировать партнёру»
//     ─▶ нет текста ─▶ awaiting_text ─ следующая реплика лички ─┐
//     ─▶ текст ──────────────────────────────────────────────────┤
//                                                                 ▼
//         модель (draft, 100%): текст на языке партнёра + смысл для автора
//                                                                 ▼
//         превью: сначала то, что увидит партнёр, потом смысл (DR10)
//           ├ «Отправить в группу» ─▶ editing → sending (R13) ─▶ outbox ─▶ черновик удалён целиком
//           ├ «Изменить текст» ─▶ awaiting_edit ─ пожелание ─▶ новое превью
//           └ «Удалить» ─▶ черновик удалён, нигде не появляется
//   Модель сама черновиков не создаёт (DR10).
//
// Заметка:
//   модель в ответе лички предлагает note_candidate, не чаще раза за окно
//   переписки (30 минут) ─▶ предложение с точным текстом (DR11)
//     ├ «Разрешить в ответах» ─▶ approved, текст открытым (идёт в общий контекст)
//     ├ «Изменить» ─▶ следующая реплика — новый текст ─▶ новое предложение
//     └ «Не разрешать» ─▶ удалена
//   /notes ─▶ список с «Отозвать» ─▶ текст стирается сразу, без модели (R15).
//
// До одобрения и в черновиках текст лежит шифротекстом (aad по владельцу).

import * as db from "./db.js";
import { draftReads } from "./db.js";
import { encrypt, decrypt } from "./crypto.js";
import { generate } from "./gemini.js";
import { text as copyText } from "./copy.js";
import { bilingual, keyboard, langLabel } from "./format.js";
import { deliver as deliverOutbound, escapeHtml, sendMessage } from "./telegram.js";

export const NOTE_OFFER_WINDOW_MS = 30 * 60 * 1000;

const draftAad = (userId) => `draft:${userId}`;
const noteAad = (userId) => `note:${userId}`;
const baseLang = (lang) => String(lang ?? "en").split(/[-_]/)[0].toLowerCase();

// --- Публикация (R13, T7) ---

// Тексты для автора, если язык неизвестен; вызывающие передают свои.
export const UNKNOWN_DELIVERY_TEXT = "Не удалось подтвердить доставку. Проверь группу перед повторной отправкой.";
export const FAILED_DELIVERY_TEXT = "Сообщение не отправилось. Черновик сохранён, можно попробовать ещё раз.";

/**
 * @param {object} draft { draftId, userId, coupleId, groupChatId, params, texts? }
 * @returns {Promise<"locked"|"sent"|"unknown"|"failed"|"already_sent"|"already_unknown"|"in_flight">}
 */
export async function publishDraft(draft, { store = db, deliver = deliverOutbound, notify = sendMessage } = {}) {
  const locked = await store.draftLockForSending(draft.draftId, draft.userId);
  if (!locked) return "locked";

  const outcome = await deliver(
    {
      key: `draft:${draft.draftId}`,
      scope: "group",
      coupleId: draft.coupleId,
      chatId: draft.groupChatId,
      method: "sendMessage",
      params: draft.params,
    },
    { store },
  );

  switch (outcome.status) {
    case "sent":
    case "already_sent":
      await store.draftDelete(draft.draftId);
      break;
    case "unknown":
    case "already_unknown":
    case "in_flight":
      await store.draftSetStatus(draft.draftId, "unknown");
      await notify(draft.userId, draft.texts?.unknown ?? UNKNOWN_DELIVERY_TEXT);
      break;
    case "failed":
      await store.draftSetStatus(draft.draftId, "editing");
      await notify(draft.userId, draft.texts?.failed ?? FAILED_DELIVERY_TEXT);
      break;
  }
  return outcome.status;
}

// --- Переформулировка ---

const DRAFT_SYSTEM = `You help one partner phrase a message to the other partner in a couple, so it can be heard.
Turn the author's raw text into a gentle start-up: speak from "I" (feelings and needs), describe the situation, not the partner's character; no blame, no sarcasm, no "always/never", no manipulation, no apologising for the author unless they said so.
Keep the author's meaning and needs. Do not invent facts, reasons, needs or requests the author did not express: if the raw text asks for nothing, the message asks for nothing. Keep the author's tone where it is not hurtful (a joke can stay light). Keep it short: at most 4 sentences.
Return JSON:
- partner_text: the message in the partner's language;
- author_meaning: the same message translated into the author's language, so the author knows exactly what will be sent.`;

const DRAFT_SCHEMA = {
  type: "OBJECT",
  properties: { partner_text: { type: "STRING" }, author_meaning: { type: "STRING" } },
  required: ["partner_text", "author_meaning"],
};

async function reformulate({ original, wish, authorLang, partnerLang }, generateFn) {
  const parts = [{ text: `Author language: ${authorLang}\nPartner language: ${partnerLang}\n\nAuthor's raw text:\n${original}` }];
  if (wish) parts.push({ text: `The author asked to change: ${wish}` });
  const r = await generateFn({ purpose: "draft", system: DRAFT_SYSTEM, parts, schema: DRAFT_SCHEMA });
  if (!r.ok) return null;
  const partnerText = String(r.data.partner_text ?? "").trim();
  const meaning = String(r.data.author_meaning ?? "").trim();
  return partnerText ? { partnerText, meaning: meaning || partnerText } : null;
}

// Превью (DR10): сначала текст для партнёра, затем смысл для автора.
async function previewMessage(draftId, { partnerText, meaning }, partnerLang, authorLang, textFn) {
  const meaningLabel = await textFn(authorLang, "draft.meaning_label");
  const sameLang = partnerLang === authorLang;
  const text =
    `<blockquote>${escapeHtml(partnerText)}</blockquote>` +
    (sameLang ? "" : `\n\n<b>${escapeHtml(meaningLabel)} · ${langLabel(authorLang)}</b>\n${escapeHtml(meaning)}`);
  return {
    text,
    reply_markup: keyboard([
      { labels: [await textFn(authorLang, "draft.send_button")], data: `dr:send:${draftId}` },
      { labels: [await textFn(authorLang, "draft.edit_button")], data: `dr:edit:${draftId}` },
      { labels: [await textFn(authorLang, "draft.delete_button")], data: `dr:del:${draftId}` },
    ]),
  };
}

/**
 * Действие с черновиком. Возвращает сообщения для лички автора: [{ text, reply_markup? }].
 * @param {object} input { couple, member, action: "start"|"text"|"send"|"edit"|"del", text?, draftId? }
 */
export async function draftAction(input, { reads = draftReads, store = db, textFn = copyText, generateFn = generate, publish = publishDraft } = {}) {
  const { couple, member, action } = input;
  const userId = Number(member.user_id ?? member.userId);
  const authorLang = baseLang(member.lang);
  const partner = couple.members.find((m) => m.userId !== userId);
  const partnerLang = baseLang(partner?.lang ?? member.lang);
  const say = async (key) => [{ text: escapeHtml(await textFn(authorLang, key)) }];

  const makePreview = async (draftId, original, wish) => {
    const result = await reformulate({ original, wish, authorLang, partnerLang }, generateFn);
    if (!result) {
      await reads.updateDraft(draftId, { status: "editing" });
      return say("draft.failed");
    }
    await reads.updateDraft(draftId, {
      status: "editing",
      reformulated: encrypt(result.partnerText, draftAad(userId)),
      translations: encrypt(JSON.stringify({ partnerLang, meaning: result.meaning }), draftAad(userId)),
    });
    return [await previewMessage(draftId, result, partnerLang, authorLang, textFn)];
  };

  if (action === "start") {
    if (!input.text) {
      await reads.createDraft({ coupleId: couple.id, userId, original: null, status: "awaiting_text" });
      return say("draft.ask_text");
    }
    const draftId = await reads.createDraft({ coupleId: couple.id, userId, original: encrypt(input.text, draftAad(userId)), status: "editing" });
    return makePreview(draftId, input.text);
  }

  if (action === "text") {
    const open = await reads.openDraft(userId);
    if (!open) return null; // реплика не для черновика
    if (open.status === "awaiting_text") {
      await reads.updateDraft(open.id, { original: encrypt(input.text, draftAad(userId)) });
      return makePreview(open.id, input.text);
    }
    if (open.status === "awaiting_edit") {
      const original = decrypt(open.original, draftAad(userId));
      return makePreview(open.id, original, input.text);
    }
    return null;
  }

  const draft = await reads.draft(input.draftId, userId);
  if (!draft) return [{ text: escapeHtml(await textFn(authorLang, "button.stale")) }];

  if (action === "del") {
    await reads.deleteDraft(draft.id, userId);
    return say("draft.deleted");
  }
  if (action === "edit") {
    await reads.updateDraft(draft.id, { status: "awaiting_edit" });
    return say("draft.ask_edit");
  }
  if (action === "send") {
    if (couple.state !== "active" || !draft.reformulated) return say("draft.not_active");
    const partnerText = decrypt(draft.reformulated, draftAad(userId));
    const { meaning } = JSON.parse(decrypt(draft.translations, draftAad(userId)));
    const header = await textFn(partnerLang, "draft.header", { name: member.display_name ?? member.name ?? "" });
    // В группе: шапка, текст на языке партнёра, версия на языке автора свёрнута (DR10).
    const body = bilingual({ primary: { lang: partnerLang, text: partnerText }, secondary: { lang: authorLang, text: meaning } });
    const status = await publish(
      {
        draftId: draft.id,
        userId,
        coupleId: couple.id,
        groupChatId: couple.groupChatId,
        params: { chat_id: couple.groupChatId, text: `<b>${escapeHtml(header)}</b>\n${body}`, parse_mode: "HTML" },
        texts: {
          unknown: await textFn(authorLang, "draft.unknown_delivery"),
          failed: await textFn(authorLang, "draft.failed_delivery"),
        },
      },
      { store },
    );
    if (status === "sent" || status === "already_sent") {
      // Отправленный текст остаётся только как сообщение общей истории.
      await store.ingestSharedBotMessage({ coupleId: couple.id, authorUserId: userId, text: partnerText });
      return say("draft.sent");
    }
    // locked — двойное нажатие; unknown/failed автору уже сообщил publishDraft.
    return [];
  }
  return [];
}

// --- Заметки (DR11, R15) ---

export function mayOfferNote(member, now = Date.now()) {
  const last = member.lastNoteOfferAt ?? member.last_note_offer_at;
  return !last || now - new Date(last).getTime() >= NOTE_OFFER_WINDOW_MS;
}

async function noteProposal(noteId, text, lang, textFn) {
  return {
    text: `${escapeHtml(await textFn(lang, "notes.offer"))}\n\n<blockquote>${escapeHtml(text)}</blockquote>`,
    reply_markup: keyboard([
      { labels: [await textFn(lang, "notes.allow_button")], data: `nt:allow:${noteId}` },
      { labels: [await textFn(lang, "notes.edit_button")], data: `nt:edit:${noteId}` },
      { labels: [await textFn(lang, "notes.deny_button")], data: `nt:deny:${noteId}` },
    ]),
  };
}

/** Предложение заметки из ответа лички. Возвращает сообщения или [] (слишком часто). */
export async function offerNote({ couple, member, text }, { reads = draftReads, store = db, textFn = copyText, now = Date.now() } = {}) {
  if (!mayOfferNote(member, now)) return [];
  const userId = Number(member.user_id ?? member.userId);
  const noteId = await reads.createNote({ coupleId: couple.id, authorUserId: userId, text: encrypt(text, noteAad(userId)) });
  await store.markNoteOffered(userId);
  return [await noteProposal(noteId, text, baseLang(member.lang), textFn)];
}

/**
 * Действие с заметкой: allow | edit | deny | revoke | text (новый текст после «Изменить») | list.
 */
export async function noteAction(input, { reads = draftReads, textFn = copyText } = {}) {
  const { member, action } = input;
  const userId = Number(member.user_id ?? member.userId);
  const lang = baseLang(member.lang);
  const say = async (key) => [{ text: escapeHtml(await textFn(lang, key)) }];

  if (action === "list") {
    const notes = await reads.activeNotesOf(userId);
    if (!notes.length) return say("notes.empty");
    const label = await textFn(lang, "notes.revoke_button");
    return [
      {
        text: `${escapeHtml(await textFn(lang, "notes.list_title"))}\n\n${notes.map((n, i) => `${i + 1}. ${escapeHtml(n.text)}`).join("\n")}`,
        reply_markup: keyboard(notes.map((n, i) => ({ labels: [`${label} ${i + 1}`], data: `nt:revoke:${n.id}` }))),
      },
    ];
  }

  if (action === "text") {
    const pending = await reads.noteAwaitingEdit(userId);
    if (!pending) return null;
    await reads.updateNote(pending.id, { text: encrypt(input.text, noteAad(userId)), awaiting_edit: false });
    return [await noteProposal(pending.id, input.text, lang, textFn)];
  }

  const note = await reads.note(input.noteId, userId);
  if (!note) return say("button.stale");

  switch (action) {
    case "allow":
      if (note.approved_at || !note.text) return say("button.stale");
      // Одобренная заметка идёт в общий контекст открытым текстом.
      await reads.updateNote(note.id, { text: decrypt(note.text, noteAad(userId)), approved_at: new Date().toISOString(), awaiting_edit: false });
      return say("notes.allowed");
    case "edit":
      if (note.approved_at) return say("button.stale");
      await reads.updateNote(note.id, { awaiting_edit: true });
      return say("notes.edit_hint");
    case "deny":
      if (note.approved_at) return say("button.stale");
      await reads.deleteNote(note.id, userId);
      return say("notes.denied");
    case "revoke":
      if (note.revoked_at) return say("button.stale");
      // R15: текст стирается сразу, без вызова модели.
      await reads.updateNote(note.id, { text: null, revoked_at: new Date().toISOString() });
      return say("notes.revoked");
    default:
      return [];
  }
}
