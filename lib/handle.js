// Маршрутизация апдейтов: группа, Guest Mode, личка, кнопки, сервисные.
// Не знает ни про вебхук, ни про очередь, ни про waitUntil: точки входа
// передают зависимости (env), и ядро одинаково работает из очереди, фолбэка
// и локального polling.
//
//   апдейт ─┬ состав группы / права бота ─▶ recheckComposition (R17)
//           ├ callback_query ─▶ кнопки /check (DR6, DR17)
//           ├ сообщение группы ─┬ не пара / посторонний ─▶ игнор
//           │                   ├ команда ─▶ /pause /resume /translate /help /check /cancel
//           │                   ├ пара не active ─▶ молчим, не сохраняем (DR3)
//           │                   ├ голосовое / кружок ─▶ приём pending ─▶ расшифровка ─▶ транскрипт
//           │                   └ текст ─▶ приём ─▶ дебаунс
//           ├ guest_message ─▶ Guest Mode (T25)
//           └ личка ─▶ онбординг и помощник в личке (T18, T23)
//
// Эффекты модулей (say, popup, ask_paraphrase, …) превращаются в сообщения
// здесь, с текстами из каталога lib/copy.

import * as db from "./db.js";
import { call, deliver, escapeHtml } from "./telegram.js";
import { text as copyText } from "./copy.js";
import { bilingual, keyboard, notification, toSendArgs } from "./format.js";
import { affectsComposition, recheckComposition } from "./onboarding.js";
import {
  DEBOUNCE_TOPIC,
  applyCheckEvent,
  onPartnerMessage,
  onTranscript,
  onVoiceMessage,
  respond,
  runCheck,
  scheduleTail,
  startCheck,
} from "./session.js";
import { MAX_VOICE_SECONDS, MEDIA_KINDS, fetchMedia, transcribeMedia, transcriptParts } from "./transcribe.js";
import { buildHelpPack, handleSignal } from "./safety.js";
import { generate } from "./gemini.js";

export const ALLOWED_UPDATES = ["message", "callback_query", "guest_message", "my_chat_member"];

export function updateKind(update) {
  return ALLOWED_UPDATES.find((kind) => update[kind] !== undefined) ?? "other";
}

const baseLang = (lang) => String(lang ?? "en").split(/[-_]/)[0].toLowerCase();
const coupleLangList = (couple) => [...new Set(couple.members.map((m) => baseLang(m.lang)))];

// --- Рендер эффектов ---

async function groupHtml(couple, key, params = {}, textFn = copyText) {
  const [a, b] = coupleLangList(couple);
  const primary = { lang: a, text: await textFn(a, key, params) };
  const secondary = b ? { lang: b, text: await textFn(b, key, params) } : undefined;
  return bilingual({ primary, secondary });
}

function nameOf(couple, userId) {
  return couple.members.find((m) => m.userId === Number(userId))?.name ?? "";
}

/**
 * Показывает эффекты модулей. Ключи идемпотентности строятся от апдейта:
 * повтор того же апдейта не публикует второй раз (R13).
 */
export async function renderEffects(effects, { couple, updateId, callback, env }) {
  const textFn = env.text ?? copyText;
  const send = env.deliver ?? deliver;
  const store = env.store ?? db;
  let index = 0;
  const post = async (params, kind = "check") => {
    const args = { method: "sendMessage", params: { chat_id: couple.groupChatId, parse_mode: "HTML", ...notification(kind), ...params } };
    return send({ key: `upd:${updateId}:${index++}`, scope: "group", coupleId: couple.id, chatId: couple.groupChatId, ...args }, { store });
  };

  for (const effect of effects) {
    switch (effect.type) {
      case "say": {
        const params = { ...effect };
        if (effect.userId) params.name = nameOf(couple, effect.userId);
        await post({ text: await groupHtml(couple, effect.key, params, textFn) });
        break;
      }
      case "popup": {
        if (!callback) break;
        const presser = couple.members.find((m) => m.userId === callback.from.id);
        const popupText = await textFn(presser?.lang ?? "en", effect.key, { name: nameOf(couple, effect.userId) });
        await (env.api ?? call)("answerCallbackQuery", { callback_query_id: callback.id, text: popupText });
        break;
      }
      case "remove_buttons": {
        if (!callback?.message) break;
        await (env.api ?? call)("editMessageReplyMarkup", {
          chat_id: callback.message.chat.id,
          message_id: callback.message.message_id,
          reply_markup: { inline_keyboard: [] },
        }).catch(() => {});
        break;
      }
      case "ask_paraphrase": {
        // Слушающему — просьба на его языке, реплаем на блок говорящего, с «Пропустить» (DR6).
        const listener = couple.members.find((m) => m.userId === effect.to);
        const lang = baseLang(listener?.lang);
        const r = await post({
          text: `${escapeHtml(listener?.name ?? "")}, ${escapeHtml(await textFn(lang, "check.ask_paraphrase"))}`,
          reply_parameters: { message_id: effect.blockMessageId ?? effect.blockTo, allow_sending_without_reply: true },
          reply_markup: keyboard([{ labels: [await textFn(lang, "check.skip_button")], data: "chk:skip" }]),
        });
        if (r.tgMessageId && effect.checkId) await store.checkSetPrompt(effect.checkId, r.tgMessageId);
        break;
      }
      case "show_paraphrase": {
        // Говорящему — пересказ на его языке с кнопками вердикта (DR6.3).
        const speaker = couple.members.find((m) => m.userId === effect.to);
        const lang = baseLang(speaker?.lang);
        const shown = await (env.translateParaphrase ?? translateParaphrase)(effect.text ?? "", lang);
        await post({
          text: `${escapeHtml(speaker?.name ?? "")}\n<blockquote>${escapeHtml(shown)}</blockquote>`,
          reply_parameters: { message_id: effect.messageId },
          reply_markup: keyboard([
            { labels: [await textFn(lang, "check.understood_button")], data: "chk:ok" },
            { labels: [await textFn(lang, "check.clarify_button")], data: "chk:clarify" },
          ]),
        });
        break;
      }
      default:
        break;
    }
  }
}

// Перевод пересказа для говорящего (уровень 90%). Не вышло — оригинал:
// пересказ всё равно виден реплаем, упражнение не ломается.
const PARAPHRASE_SCHEMA = { type: "OBJECT", properties: { text: { type: "STRING" } }, required: ["text"] };
async function translateParaphrase(text, lang) {
  if (!text) return text;
  const r = await generate({
    purpose: "check_paraphrase",
    system: "Translate the paraphrase into the target language, meaning and tone, no interpretation. If it is already in that language, return it unchanged. Return JSON {\"text\"}.",
    parts: [{ text: `Target language: ${lang}\n\n${text}` }],
    schema: PARAPHRASE_SCHEMA,
  });
  return r.ok && r.data.text ? String(r.data.text) : text;
}

// --- Группа ---

function isCommand(message, name) {
  const text = message.text ?? "";
  return new RegExp(`^/${name}(@\\w+)?(\\s|$)`).test(text);
}

function addressesBot(message, botUsername) {
  if (message.reply_to_message?.from?.is_bot && message.reply_to_message.from.username === botUsername) return true;
  return Boolean(botUsername) && (message.text ?? "").includes(`@${botUsername}`);
}

function schedulingDeps(env) {
  const deps = {
    enqueue: env.enqueue,
    defer: env.defer,
    store: env.store ?? db,
  };
  deps.run = (check) => runCheck(check, { store: deps.store, respond: (w, marker) => respond(w, marker, respondDeps(env)) });
  return deps;
}

function respondDeps(env) {
  return {
    ...(env.respondDeps ?? {}),
    scheduleTail: (windowId, messageId) => scheduleTail(windowId, messageId, schedulingDeps(env)),
  };
}

async function groupCommand(message, couple, updateId, env) {
  const store = env.store ?? db;
  const from = message.from.id;
  const effects = [];

  if (isCommand(message, "help")) {
    const langs = coupleLangList(couple);
    const text = (await groupHtml(couple, "help.group", {}, env.text)) + "\n\n" + (await buildHelpPack(couple.id, langs, { store, textFn: env.text ?? copyText }));
    await renderRaw(couple, updateId, text, "status", env);
    return true;
  }
  if (isCommand(message, "pause")) {
    const t = await store.coupleTransition(couple.id, "pause", from);
    effects.push({ type: "say", key: t.ok ? "state.paused" : "state.not_active" });
  } else if (isCommand(message, "resume")) {
    const t = await store.coupleTransition(couple.id, "resume", from);
    effects.push({ type: "say", key: t.ok ? "state.resumed" : t.reason === "not_pauser" ? "state.resume_not_pauser" : "state.not_active" });
  } else if (isCommand(message, "translate")) {
    if (couple.state !== "active") effects.push({ type: "say", key: "state.not_active" });
    else {
      await store.setAutoTranslate(couple.id, !couple.autoTranslate);
      effects.push({ type: "say", key: couple.autoTranslate ? "translate.off" : "translate.on" });
    }
  } else if (isCommand(message, "check")) {
    if (couple.state !== "active") effects.push({ type: "say", key: "state.not_active" });
    else {
      const listener = couple.members.find((m) => m.userId !== from);
      const blockTo = message.reply_to_message?.message_id ?? message.message_id;
      const r = await startCheck({ coupleId: couple.id, speaker: from, listener: listener.userId, blockFrom: blockTo, blockTo }, { store });
      effects.push(...r.effects.map((e) => ({ ...e, checkId: r.id })));
    }
  } else if (isCommand(message, "cancel")) {
    effects.push(...(await applyCheckEvent(couple.id, { type: "cancel", userId: from }, { store })));
  } else {
    return false;
  }
  await renderEffects(effects, { couple, updateId, env });
  return true;
}

async function renderRaw(couple, updateId, html, kind, env) {
  const send = env.deliver ?? deliver;
  await send(
    {
      key: `upd:${updateId}:raw`,
      scope: "group",
      coupleId: couple.id,
      chatId: couple.groupChatId,
      method: "sendMessage",
      params: { chat_id: couple.groupChatId, text: html, parse_mode: "HTML", ...notification(kind) },
    },
    { store: env.store ?? db },
  );
}

async function groupVoice(message, couple, media, kindName, ingest, updateId, env) {
  const store = env.store ?? db;
  const deps = schedulingDeps(env);
  await onVoiceMessage({ windowId: ingest.windowId, messageId: ingest.messageId }, deps);

  const duration = Number(media.duration);
  const author = couple.members.find((m) => m.userId === message.from.id);
  const partner = couple.members.find((m) => m.userId !== message.from.id);
  const targetLang = baseLang(partner?.lang ?? author?.lang);
  const textFn = env.text ?? copyText;

  if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_VOICE_SECONDS) {
    // Не расшифровываем: статус станет failed на потолке, ведущий ответит с пометкой.
    await renderEffects([{ type: "say", key: "voice.not_recognized" }], { couple, updateId, env });
    return;
  }

  const result = await (env.transcribe ?? (async () => {
    const bytes = await fetchMedia(media.file_id);
    return transcribeMedia({ bytes, mimeType: MEDIA_KINDS[kindName](media), surface: "group", targetLang });
  }))();

  if (result.blocked === "crisis") {
    const context = { coupleId: couple.id, groupChatId: couple.groupChatId, members: couple.members };
    await (env.onSafety ?? handleSignal)({ signal: "crisis", surface: "group", context, windowId: ingest.windowId });
    return;
  }
  if (!result.ok) {
    const key = result.unavailable === "quota" ? "voice.quota" : "voice.not_recognized";
    await renderEffects([{ type: "say", key }], { couple, updateId, env });
    return;
  }

  // Транскрипт публикуется всегда, даже поздний (R26, DR25).
  const lang = baseLang(author?.lang);
  const parts = transcriptParts({
    chatId: couple.groupChatId,
    replyTo: message.message_id,
    result,
    surface: "group",
    durationSeconds: duration,
    targetLang,
    summaryLabel: await textFn(targetLang, "voice.summary_label"),
    fileNotice: await textFn(lang, "voice.transcript_file"),
  });
  const send = env.deliver ?? deliver;
  for (const [i, part] of parts.entries()) {
    await send(
      { key: `voice:${ingest.messageId}:${i}`, scope: "group", coupleId: couple.id, chatId: couple.groupChatId, ...toSendArgs(part) },
      { store },
    );
  }
  await onTranscript({ windowId: ingest.windowId, messageId: ingest.messageId, text: result.transcript, lang: result.lang }, deps);
}

export async function handleGroupMessage(update, env = {}) {
  const store = env.store ?? db;
  const message = update.message;
  const couple = await store.coupleByChat(message.chat.id);
  if (!couple) return "unknown_chat"; // регистрация группы — онбординг (T18)

  const isMember = couple.members.some((m) => m.userId === message.from?.id);
  if (!isMember || message.from?.is_bot) return "not_member";

  if (message.text?.startsWith("/") && (await groupCommand(message, couple, update.update_id, env))) return "command";

  // Пауза, отзыв, приостановка: новые сообщения группы не сохраняются (DR3).
  if (couple.state !== "active") return `ignored_${couple.state}`;

  // Активный /check: реплика может быть пересказом или уточнением (DR6).
  const checkEffects = await applyCheckEvent(
    couple.id,
    {
      type: "message",
      userId: message.from.id,
      replyToMessageId: message.reply_to_message?.message_id ?? null,
      messageId: message.message_id,
      text: message.text ?? null,
    },
    { store },
  );
  if (checkEffects.length) await renderEffects(checkEffects, { couple, updateId: update.update_id, env });

  const kindName = message.voice ? "voice" : message.video_note ? "video_note" : message.text ? "text" : null;
  if (!kindName) return "unsupported";

  const ingest = await store.ingestGroupMessage({
    coupleId: couple.id,
    authorUserId: message.from.id,
    tgChatId: message.chat.id,
    tgMessageId: message.message_id,
    text: message.text ?? null,
    kind: kindName,
    addressesBot: addressesBot(message, env.botUsername),
  });
  if (ingest.duplicate) return "duplicate";

  if (kindName === "text") {
    await onPartnerMessage({ windowId: ingest.windowId, messageId: ingest.messageId }, schedulingDeps(env));
    return "text";
  }
  await groupVoice(message, couple, message.voice ?? message.video_note, kindName, ingest, update.update_id, env);
  return "voice";
}

async function handleCallback(update, env) {
  const store = env.store ?? db;
  const callback = update.callback_query;
  const chatId = callback.message?.chat?.id;
  const couple = chatId ? await store.coupleByChat(chatId) : null;
  if (!couple) return "unknown";

  const [scope, action] = String(callback.data ?? "").split(":");
  if (scope !== "chk") return "unknown";
  const event =
    action === "skip"
      ? { type: "skip", userId: callback.from.id }
      : { type: "verdict", userId: callback.from.id, understood: action === "ok" };
  const effects = await applyCheckEvent(couple.id, event, { store });
  await renderEffects(effects, { couple, updateId: update.update_id, callback, env });
  if (!effects.some((e) => e.type === "popup")) await (env.api ?? call)("answerCallbackQuery", { callback_query_id: callback.id }).catch(() => {});
  return "check";
}

export async function handleUpdate(update, env = {}) {
  const store = env.store ?? db;
  const pending = [];
  const envWithDefer = { ...env, defer: env.defer ?? ((p) => pending.push(p)) };

  try {
    if (affectsComposition(update)) {
      const chatId = update.message?.chat?.id ?? update.my_chat_member?.chat?.id;
      const couple = chatId ? await store.coupleByChat(chatId) : null;
      if (couple) {
        const effects = await recheckComposition({
          id: couple.id,
          groupChatId: couple.groupChatId,
          state: couple.state,
          memberIds: couple.members.map((m) => m.userId),
        });
        await renderEffects(effects, { couple, updateId: update.update_id, env: envWithDefer });
      }
      return "composition";
    }
    if (update.callback_query) return await handleCallback(update, envWithDefer);

    const chatType = update.message?.chat?.type;
    if (chatType === "group" || chatType === "supergroup") return await handleGroupMessage(update, envWithDefer);

    // Личка, Guest Mode и онбординг — следующие задачи; пока только лог без текста.
    console.log(`[handle] ${updateKind(update)} ${update.update_id}`);
    return "not_routed";
  } finally {
    // Без очереди проверки дебаунса ждут сном; дожидаемся их здесь, чтобы
    // функция не завершилась раньше (фолбэк R1).
    if (pending.length) await Promise.allSettled(pending);
  }
}

export { DEBOUNCE_TOPIC };
