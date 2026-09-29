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
import {
  affectsComposition,
  checkGroup,
  onboardingStep,
  readyHtml,
  recheckComposition,
  signInvite,
  statusLine,
  verifyInvite,
} from "./onboarding.js";
import {
  DEBOUNCE_TOPIC,
  applyCheckEvent,
  nextQuotaReset,
  onPartnerMessage,
  onTranscript,
  onVoiceMessage,
  recapWindow,
  respond,
  runCheck,
  scheduleTail,
  startCheck,
} from "./session.js";
import { MAX_VOICE_SECONDS, MEDIA_KINDS, fetchMedia, transcribeMedia, transcriptParts } from "./transcribe.js";
import { buildHelpPack, handleSignal, refreshHelpLines } from "./safety.js";
import { generate } from "./gemini.js";
import { encrypt } from "./crypto.js";
import { ContextRefused, buildDmContext, buildGroupContext } from "./context.js";
import { DM_SCHEMA, DM_SYSTEM, GUEST_SCHEMA, GUEST_SYSTEM, dmPrompt, guestPrompt, normalizeDm } from "./counsel.js";
import { draftAction, noteAction, offerNote, publishDraft } from "./draft.js";
import { COMMANDS, commandAction } from "./commands.js";

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

  // Предыдущее окно закрылось по тишине — итог и сводка в фоне (DR9, R30).
  if (ingest.closedWindowId) {
    const defer = env.defer ?? (() => {});
    defer(
      (env.recapWindow ?? recapWindow)({ closedWindowId: ingest.closedWindowId, newWindowId: ingest.windowId, couple }, { store, deliver: env.deliver }).catch(
        (error) => console.error(`[handle] итог окна упал: ${error.name}: ${error.message}`),
      ),
    );
  }

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

// --- Онбординг (DR7, DR8) ---

async function sendDm(userId, messages, updateId, env) {
  const send = env.deliver ?? deliver;
  for (const [i, m] of messages.entries()) {
    if (!m.text) continue;
    const params = { chat_id: userId, text: m.text, parse_mode: "HTML" };
    if (m.reply_markup) params.reply_markup = m.reply_markup;
    await send({ key: `upd:${updateId}:dm:${i}`, scope: "dm", chatId: userId, method: "sendMessage", params }, { store: env.store ?? db });
  }
}

async function refreshStatus(coupleId, env) {
  const store = env.store ?? db;
  const couple = await store.coupleById(coupleId);
  if (!couple?.groupChatId) return;
  const messageId = await store.statusMessageId(coupleId);
  if (!messageId) return;
  await (env.api ?? call)("editMessageText", {
    chat_id: couple.groupChatId,
    message_id: messageId,
    text: statusLine(couple.members),
  }).catch(() => {}); // «message is not modified» и подобное — не ошибка для нас
}

async function handleGroupStart(message, env, updateId) {
  const store = env.store ?? db;
  const api = env.api ?? call;
  const textFn = env.text ?? copyText;
  const chatId = message.chat.id;
  const lang = baseLang(message.from.language_code);
  const send = env.deliver ?? deliver;
  const post = (key, params) =>
    send({ key: `upd:${updateId}:${key}`, scope: "group", chatId, method: "sendMessage", params: { chat_id: chatId, parse_mode: "HTML", ...params } }, { store });

  if (await store.coupleByChat(chatId)) return "already_registered";

  const check = await (env.checkGroup ?? checkGroup)(chatId, [message.from.id], { api });
  if (!check.ok) {
    const text = check.reason === "not_admin"
      ? await textFn(lang, "onboarding.admin_request", { bot: env.botUsername })
      : await textFn(lang, "onboarding.need_two");
    await post("start", { text: escapeHtml(text) });
    return check.reason;
  }

  const coupleId = await store.createCoupleForChat(chatId);
  await store.joinCouple(coupleId, message.from.id, message.from.first_name ?? null, lang);

  const langs = [...new Set([lang, "en"])];
  const intro = await Promise.all(langs.map((l) => textFn(l, "onboarding.group_intro")));
  const buttonLabels = await Promise.all(langs.map((l) => textFn(l, "onboarding.open_bot")));
  const link = `https://t.me/${env.botUsername}?start=${signInvite(coupleId)}`;
  await post("intro", { text: intro.map(escapeHtml).join("\n"), reply_markup: keyboard([{ labels: buttonLabels, url: link }]) });

  const couple = await store.coupleByChat(chatId);
  const status = await post("status", { text: statusLine(couple.members), ...notification("status") });
  if (status.tgMessageId) {
    await store.setStatusMessage(coupleId, status.tgMessageId);
    await api("pinChatMessage", { chat_id: chatId, message_id: status.tgMessageId, disable_notification: true }).catch(() => {});
  }
  return "registered";
}

async function afterOnboarding(results, member, updateId, env) {
  const store = env.store ?? db;
  for (const r of results) {
    if (r.effect === "consented" || r.effect === "activated") await refreshStatus(member.couple_id, env);
    if (r.effect === "activated") {
      const couple = await store.coupleByMember(member.user_id);
      const html = await readyHtml(coupleLangList(couple), env.text ?? copyText);
      await (env.deliver ?? deliver)(
        {
          key: `ready:${couple.id}`,
          scope: "group",
          coupleId: couple.id,
          chatId: couple.groupChatId,
          method: "sendMessage",
          params: { chat_id: couple.groupChatId, text: html, parse_mode: "HTML" },
        },
        { store },
      );
    }
  }
}

async function handleDm(update, env) {
  const store = env.store ?? db;
  const textFn = env.text ?? copyText;
  const updateId = update.update_id;
  const message = update.message;
  const callback = update.callback_query;
  const from = (message ?? callback).from;
  const lang = baseLang(from.language_code);

  // /start со ссылкой приглашения: вступление в пару.
  const startMatch = /^\/start(?:\s+(\S+))?/.exec(message?.text ?? "");
  let member = await store.memberGet(from.id);

  if (startMatch?.[1] && !member) {
    const coupleId = verifyInvite(startMatch[1]);
    const couple = coupleId ? await store.coupleById(coupleId) : null;
    if (!couple) {
      await sendDm(from.id, [{ text: escapeHtml(await textFn(lang, "state.stranger_start")) }], updateId, env);
      return "stranger";
    }
    const inGroup = await (env.api ?? call)("getChatMember", { chat_id: couple.groupChatId, user_id: from.id }).catch(() => null);
    if (!inGroup || !["creator", "administrator", "member", "restricted"].includes(inGroup.status)) {
      await sendDm(from.id, [{ text: escapeHtml(await textFn(lang, "onboarding.not_in_group")) }], updateId, env);
      return "not_in_group";
    }
    const joined = await store.joinCouple(couple.id, from.id, from.first_name ?? null, lang);
    if (!joined.ok) {
      const key = joined.reason === "full" ? "onboarding.couple_full" : "onboarding.other_couple";
      await sendDm(from.id, [{ text: escapeHtml(await textFn(lang, key)) }], updateId, env);
      return joined.reason;
    }
    member = await store.memberGet(from.id);
    await refreshStatus(couple.id, env);
  }

  if (!member) {
    if (message) await sendDm(from.id, [{ text: escapeHtml(await textFn(lang, "state.stranger_start")) }], updateId, env);
    return "stranger";
  }

  if (member.onboarding_step !== "done") {
    const input = callback ? { callback: String(callback.data).replace(/^ob:/, "") } : { text: startMatch ? null : message?.text };
    const results = await onboardingStep(member, input, { store, textFn });
    if (callback) {
      await (env.api ?? call)("answerCallbackQuery", { callback_query_id: callback.id }).catch(() => {});
      await (env.api ?? call)("editMessageReplyMarkup", {
        chat_id: from.id,
        message_id: callback.message.message_id,
        reply_markup: { inline_keyboard: [] },
      }).catch(() => {});
    }
    await sendDm(from.id, results, updateId, env);
    await afterOnboarding(results, member, updateId, env);

    // Страна выбрана — номера помощи подтягиваются заранее, не в кризис (T19).
    const fresh = await store.memberGet(from.id);
    if (fresh?.country && fresh.country !== member.country) {
      const cached = await store.helpLinesGet([fresh.country]);
      if (!cached.length) (env.defer ?? (() => {}))((env.refreshHelpLines ?? refreshHelpLines)(fresh.country).catch(() => {}));
    }
    return "onboarding";
  }

  return await handleDmTools(update, member, env);
}

// Черновики, заметки и команды лички; остальное — разговор (handleDmChat).
async function handleDmTools(update, member, env) {
  const store = env.store ?? db;
  const couple = await store.coupleByMember(member.user_id);
  const callback = update.callback_query;
  const message = update.message;
  const reply = (messages) => sendDm(member.user_id, messages ?? [], update.update_id, env);
  async function runCommand(action) {
    const r = await commandAction(member, couple, action, { store, textFn: env.text ?? copyText });
    if (r.delegate === "notes") return reply(await noteAction({ member, action: "list" }, deps)).then(() => "notes_list");
    if (r.delegate === "help") {
      const lang = baseLang(member.lang);
      const helpText = (await buildHelpPack(couple.id, [lang], { store, textFn: env.text ?? copyText }));
      await reply([{ text: helpText }]);
      return "help";
    }
    await reply(r.dm);
    if (r.group.length && couple.groupChatId) {
      await renderEffects(
        r.group.map((key) => ({ type: "say", key })),
        { couple, updateId: `${update.update_id}:cmd`, env },
      );
    }
    return `cmd_${action}`;
  }

  const deps = {
    store,
    textFn: env.text ?? copyText,
    generateFn: env.generate ?? generate,
    publish: (draft, options) =>
      publishDraft(draft, {
        ...options,
        deliver: env.deliver ?? deliver,
        notify: (userId, text) => sendDm(userId, [{ text: escapeHtml(text) }], `${update.update_id}:notify`, env),
      }),
  };

  if (callback) {
    const [scope, action, id] = String(callback.data ?? "").split(":");
    await (env.api ?? call)("answerCallbackQuery", { callback_query_id: callback.id }).catch(() => {});
    await (env.api ?? call)("editMessageReplyMarkup", {
      chat_id: member.user_id,
      message_id: callback.message.message_id,
      reply_markup: { inline_keyboard: [] },
    }).catch(() => {});
    if (scope === "dr") {
      const map = { compose: "start", send: "send", edit: "edit", del: "del" };
      await reply(await draftAction({ couple, member, action: map[action], draftId: Number(id) }, deps));
      return `draft_${action}`;
    }
    if (scope === "nt") {
      await reply(await noteAction({ member, action, noteId: Number(id) }, deps));
      return `note_${action}`;
    }
    if (scope === "mn") {
      return runCommand([action, id].filter(Boolean).join(":"));
    }
    return "dm_callback_unknown";
  }

  const text = message?.text ?? "";
  const command = /^\/(\w+)(?:@\w+)?(?:\s|$)/.exec(text)?.[1];
  if (command && COMMANDS[command]) return runCommand(COMMANDS[command]);
  // Отозвавший согласие: разговор не идёт (дизайн-док «Отзыв»).
  if (member.revoked_at) return runCommand("do:chat_blocked");

  const draftCommand = /^\/draft(?:@\w+)?(?:\s+([\s\S]+))?$/.exec(text);
  if (draftCommand) {
    await reply(await draftAction({ couple, member, action: "start", text: draftCommand[1]?.trim() || null }, deps));
    return "draft_start";
  }
  if (/^\/notes(@\w+)?$/.test(text)) {
    await reply(await noteAction({ member, action: "list" }, deps));
    return "notes_list";
  }
  if (text && !text.startsWith("/")) {
    const forDraft = await draftAction({ couple, member, action: "text", text }, deps);
    if (forDraft) {
      await reply(forDraft);
      return "draft_text";
    }
    const forNote = await noteAction({ member, action: "text", text }, deps);
    if (forNote) {
      await reply(forNote);
      return "note_text";
    }
  }
  const chatEnv = {
    ...env,
    onNoteCandidate:
      env.onNoteCandidate ??
      (async ({ couple: c, member: m, text: noteText }) => reply(await offerNote({ couple: c, member: m, text: noteText }, { store, textFn: deps.textFn }))),
  };
  return await handleDmChat(update, member, chatEnv);
}

// --- Помощник в личке (T23; premise 2, DR10, DR14, DR25) ---
//
//   реплика ─▶ голосовое? ─▶ расшифровка (100%) ─▶ транскрипт владельцу
//          ─▶ сохранить шифротекстом (aad dm:X) + удалить старше 6 дней (R27)
//          ─▶ контекст лички ─▶ модель (dm_reply)
//               ├ crisis ─▶ набор помощи только X, без ответа модели
//               ├ abuse  ─▶ флаг dm:X, набор X, ответ модели
//               ├ блок neutral ─▶ «не могу обработать»
//               └ сбой / квота ─▶ фолбэк + «Срочная помощь: /help» (DR14)
//          ─▶ ответ с кнопкой «Сформулировать партнёру» (DR10), сохранить

async function handleDmChat(update, member, env) {
  const store = env.store ?? db;
  const textFn = env.text ?? copyText;
  const message = update.message;
  if (!message) return "dm_callback_not_routed";
  const userId = Number(member.user_id);
  const lang = baseLang(member.lang);
  const couple = await store.coupleByMember(userId);
  const send = env.deliver ?? deliver;
  const reply = (key, text, extra = {}) =>
    send(
      { key: `dm:${userId}:${message.message_id}:${key}`, scope: "dm", coupleId: couple.id, chatId: userId, method: "sendMessage", params: { chat_id: userId, text, parse_mode: "HTML", ...extra } },
      { store },
    );

  if (member.revoked_at) return "revoked_owner"; // команды /consent и /forget — T22

  let text = message.text ?? null;
  let kind = "text";
  const media = message.voice ?? message.video_note;
  if (media) {
    kind = message.voice ? "voice" : "video_note";
    const result = await (env.transcribe ?? (async () => {
      const bytes = await fetchMedia(media.file_id);
      return transcribeMedia({ bytes, mimeType: MEDIA_KINDS[kind](media), surface: "dm", targetLang: lang });
    }))();
    if (result.blocked === "crisis") {
      await dmSignal("crisis", couple, userId, env);
      return "dm_crisis";
    }
    if (!result.ok) {
      await reply("voice", escapeHtml(await textFn(lang, result.unavailable === "quota" ? "voice.quota" : "voice.not_recognized")));
      return "dm_voice_failed";
    }
    const parts = transcriptParts({ chatId: userId, replyTo: message.message_id, result: { ...result, translation: "" }, surface: "dm", durationSeconds: Number(media.duration), targetLang: lang, summaryLabel: "", fileNotice: await textFn(lang, "voice.transcript_file") });
    for (const [i, part] of parts.entries()) await send({ key: `dm:${userId}:${message.message_id}:t${i}`, scope: "dm", coupleId: couple.id, chatId: userId, ...toSendArgs(part) }, { store });
    text = result.transcript;
  }
  if (!text) return "dm_unsupported";
  // Запасной путь Guest Mode: пересланное сообщение партнёра объясняется в личке (DR12).
  const forwarded = Boolean(message.forward_origin);
  if (forwarded) text = `[forwarded message] ${text}`;

  const stored = await store.ingestDmMessage({
    coupleId: couple.id, ownerUserId: userId, authorUserId: userId, isBot: false, tgMessageId: message.message_id,
    text: encrypt(text, `dm:${userId}`), kind,
  });
  if (stored === null) return "duplicate";

  const context = await (env.buildDmContext ?? buildDmContext)(couple.id, userId);
  const owner = couple.members.find((m) => m.userId === userId);
  const partner = couple.members.find((m) => m.userId !== userId) ?? null;
  const result = await (env.generate ?? generate)({
    purpose: "dm_reply",
    system: DM_SYSTEM,
    parts: [{ text: dmPrompt(context, owner, partner) }],
    schema: DM_SCHEMA,
  });

  let html;
  let noteCandidate = null;
  if (result.ok) {
    const dmReply = normalizeDm(result.data);
    if (dmReply.safety === "crisis") {
      await dmSignal("crisis", couple, userId, env);
      return "dm_crisis";
    }
    if (dmReply.safety === "abuse") await dmSignal("abuse", couple, userId, env);
    html = dmReply.reply ? escapeHtml(dmReply.reply) : escapeHtml(await textFn(lang, "fallback.neutral_block"));
    noteCandidate = dmReply.noteCandidate;
  } else if (result.blocked === "crisis") {
    await dmSignal("crisis", couple, userId, env);
    return "dm_crisis";
  } else if (result.blocked === "neutral") {
    html = escapeHtml(await textFn(lang, "fallback.neutral_block"));
  } else {
    html = `${escapeHtml(await textFn(lang, "fallback.dm"))}\n\n${escapeHtml(await textFn(lang, "fallback.urgent_help"))}`;
  }

  if (forwarded) html += `\n\n<i>${escapeHtml(await textFn(lang, "guest.only_you"))}</i>`;
  const composeButton = keyboard([{ labels: [await textFn(lang, "draft.compose_button")], data: "dr:compose" }]);
  const sent = await reply("r", html, { reply_markup: composeButton });
  await store.ingestDmMessage({
    coupleId: couple.id, ownerUserId: userId, authorUserId: null, isBot: true, tgMessageId: sent.tgMessageId ?? null,
    text: encrypt(html, `dm:${userId}`), kind: "text",
  });
  // Предложение заметки — после ответа, отдельным сообщением (DR11).
  if (noteCandidate && env.onNoteCandidate) await env.onNoteCandidate({ couple, member, text: noteCandidate });
  return "dm_reply";
}

// Сигнал из лички: набор только автору; группа и партнёр ничего не узнают (DR21).
async function dmSignal(signal, couple, userId, env) {
  const context = { coupleId: couple.id, groupChatId: couple.groupChatId, members: couple.members };
  await (env.onSafety ?? handleSignal)({ signal, surface: "dm", context, fromUserId: userId });
}

// --- Guest Mode (DR12; дизайн-док «Guest Mode») ---
//
//   вызвал не X и не Y ─▶ молчим, модель не зовём
//   чат подтверждён как личка пары ─▶ оба сообщения в историю (scope guest),
//                                     ответ в общем контексте, оба языка
//   иначе ─▶ без контекста и без сохранения, язык вызвавшего
//   сигнал ─▶ в чат нейтральная строка; набор помощи: подтверждён — обоим,
//             флаг group; не подтверждён — только вызвавшему, без флага
//
// Спайк 2026-09-29 (личка пары, реплай на текст): chat.type = "private",
// chat.id = id собеседника (партнёра), from = вызвавший, reply_to_message
// приходит целиком. Поэтому личка пары = private-чат, чей id равен партнёру.
// from.language_code в guest_message нет — язык берём из профиля участника.
// Ответ через 60 с Telegram принимает, заглушка с последующим edit не нужна.
// Чат с третьим может быть и группой (chat.type = "group") — тоже не пара.

const GUEST_INACTIVE_TEXT = {
  onboarding: "guest.not_ready",
  paused: "guest.paused",
  revoked: "guest.revoked",
  suspended: "guest.suspended",
};

// tz в members — смещение «+03:00»; Intl понимает его как пояс.
const tzName = (tz) => (tz && /^[+-]\d{2}:\d{2}$/.test(tz) ? tz : "UTC");

export function isCoupleChat(guestMessage, couple, callerId) {
  const partner = couple.members.find((m) => m.userId !== callerId);
  return guestMessage.chat?.type === "private" && Boolean(partner) && Number(guestMessage.chat.id) === partner.userId;
}

async function handleGuest(update, env) {
  const store = env.store ?? db;
  const textFn = env.text ?? copyText;
  const gm = update.guest_message;
  const callerId = gm.from?.id;
  const couple = callerId ? await store.coupleByMember(callerId) : null;
  if (!couple || !couple.members.some((m) => m.userId === callerId)) return "guest_stranger";

  const caller = couple.members.find((m) => m.userId === callerId);
  const confirmed = isCoupleChat(gm, couple, callerId);
  const langs = confirmed ? coupleLangList(couple) : [baseLang(caller.lang)];
  const repliedTo = gm.reply_to_message;
  const author = repliedTo ? couple.members.find((m) => m.userId === repliedTo.from?.id) : null;

  const answer = async (html) =>
    (env.deliver ?? deliver)(
      {
        key: `guest:${gm.guest_query_id}`,
        scope: "guest",
        coupleId: couple.id,
        chatId: gm.chat?.id ?? callerId,
        method: "answerGuestQuery",
        params: {
          guest_query_id: gm.guest_query_id,
          result: { type: "article", id: "reply", title: "reply", input_message_content: { message_text: html, parse_mode: "HTML" } },
        },
      },
      { store },
    );
  const plain = async (key, paramsFor = () => ({})) => {
    const texts = await Promise.all(langs.map((l) => textFn(l, key, paramsFor(l))));
    return [...new Set(texts)].map(escapeHtml).join("\n");
  };
  // Время сброса квоты — по поясу участника с этим языком (как в группе).
  const resetFor = (l) => {
    const member = couple.members.find((m) => baseLang(m.lang) === l) ?? caller;
    const at = new Date(nextQuotaReset(env.now?.() ?? Date.now()));
    return { reset: new Intl.DateTimeFormat(l, { timeZone: tzName(member?.tz), hour: "2-digit", minute: "2-digit" }).format(at) };
  };

  // Не отвечаем — объясняем почему и что сделать: «не могу» без причины бесполезно.
  if (couple.state !== "active") {
    await answer(await plain(GUEST_INACTIVE_TEXT[couple.state] ?? "guest.not_ready"));
    return "guest_inactive";
  }

  let context = null;
  if (confirmed) {
    for (const m of [repliedTo, gm].filter((x) => x?.text)) {
      await store.ingestGuestMessage({ coupleId: couple.id, authorUserId: m.from?.id, tgChatId: gm.chat.id, tgMessageId: m.message_id, text: m.text });
    }
    try {
      context = await (env.buildGroupContext ?? buildGroupContext)(couple.id);
    } catch (error) {
      if (!(error instanceof ContextRefused)) throw error;
    }
  }

  // Реплай на голосовое или кружок: медиа идёт в тот же вызов, отдельной
  // расшифровки нет. В историю такое сообщение не пишется — транскрипта нет.
  const mediaKind = repliedTo ? Object.keys(MEDIA_KINDS).find((k) => repliedTo[k]) : null;
  let mediaPart = null;
  if (mediaKind) {
    const media = repliedTo[mediaKind];
    const duration = Number(media.duration);
    try {
      if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_VOICE_SECONDS) throw new Error("duration");
      const bytes = await (env.fetchMedia ?? fetchMedia)(media.file_id);
      mediaPart = { inline_data: { mime_type: MEDIA_KINDS[mediaKind](media), data: bytes.toString("base64") } };
    } catch {
      await answer(await plain("guest.voice_unavailable"));
      return "guest_media_unavailable";
    }
  }

  const result = await (env.generate ?? generate)({
    purpose: "guest",
    system: GUEST_SYSTEM,
    parts: [
      { text: guestPrompt({ confirmed, caller, author, langs, summoning: gm.text, repliedTo: repliedTo?.text ?? repliedTo?.caption, repliedMedia: mediaKind, context }) },
      ...(mediaPart ? [mediaPart] : []),
    ],
    schema: GUEST_SCHEMA,
    mediaResolution: mediaKind === "video_note" ? "MEDIA_RESOLUTION_LOW" : undefined,
    timeoutMs: mediaPart ? 120_000 : undefined,
  });

  const signal = result.blocked === "crisis" ? "crisis" : result.ok && ["crisis", "abuse"].includes(result.data.safety) ? result.data.safety : null;
  if (signal) {
    const safetyContext = { coupleId: couple.id, groupChatId: couple.groupChatId, members: couple.members };
    await (env.onSafety ?? handleSignal)(
      confirmed
        ? { signal, surface: "guest", context: safetyContext }
        : { signal, surface: "dm", context: safetyContext, fromUserId: callerId, noFlag: true },
    );
    await answer(await plain("safety.group_line"));
    return `guest_${signal}`;
  }
  if (!result.ok) {
    if (result.blocked === "neutral") await answer(await plain("fallback.neutral_block"));
    else if (result.unavailable === "quota") await answer(await plain("guest.quota", resetFor));
    else await answer(await plain("guest.unavailable"));
    return "guest_fallback";
  }

  const byLang = new Map((result.data.lines ?? []).map((l) => [baseLang(l.lang), String(l.text ?? "").trim()]));
  const ordered = langs.filter((l) => byLang.get(l)).map((lang) => ({ lang, text: byLang.get(lang) }));
  if (!ordered.length) {
    await answer(await plain("guest.unavailable"));
    return "guest_fallback";
  }
  await answer(bilingual({ primary: ordered[0], secondary: ordered[1] }));
  return confirmed ? "guest_confirmed" : "guest_unconfirmed";
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
    if (update.guest_message) return await handleGuest(update, envWithDefer);
    if (update.callback_query?.message?.chat?.type === "private") return await handleDm(update, envWithDefer);
    if (update.callback_query) return await handleCallback(update, envWithDefer);

    const chatType = update.message?.chat?.type;
    if ((chatType === "group" || chatType === "supergroup") && /^\/start(@\w+)?(\s|$)/.test(update.message.text ?? "")) {
      return await handleGroupStart(update.message, envWithDefer, update.update_id);
    }
    if (chatType === "group" || chatType === "supergroup") return await handleGroupMessage(update, envWithDefer);
    if (chatType === "private") return await handleDm(update, envWithDefer);

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
