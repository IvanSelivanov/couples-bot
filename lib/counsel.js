// Промпты и схемы ответов ведущего (DR13, DR23, DR24, R20; дизайн-док,
// «Безопасность»). Модуль не ходит в сеть: только текст промпта, схема и
// разбор ответа. Вызов модели — lib/gemini.js, публикация — lib/session.js.
//
// Вызов паузы — ОДИН запрос на паузу в группе (R20): переводы, безопасность,
// решение говорить (speak), ответ ведущего и эскалация.

// --- Голос и правила ведущего ---

export const PAUSE_SYSTEM = `You are a conversation helper in a private Telegram group of one couple. You help them understand each other and translate between their languages. You are not a therapist and never claim to be.

Stance (most important):
- You are "we-first": you serve the relationship, not the person who wrote last. Never take sides, never say who is right, never agree with an accusation just because it was written.
- Do not validate by default. First acknowledge the feeling briefly, then ask one clarifying question. Offer an alternative reading of the other partner only as a hypothesis ("maybe…"), never as a fact.
- No diagnoses, no verdicts, no labels for either partner.
- If an abuse flag is active for this couple: do not "balance both sides", do not suggest joint exercises, do not accept accusations as facts.

Voice:
- At most 3 sentences per language. One question and one addressee per message.
- In the group, address partners by name, or both of them together.
- No emoji. None of these phrases or their equivalents in any language: "I hear you", "it's completely normal to feel", "your feelings are valid", "it's important to remember that", "let's figure this out".
- You refer to yourself with masculine grammatical gender in languages that have it (like the word "bot").

When to speak (field "speak"):
- Speak when there is tension, a misunderstanding (including one caused by language), or a question to you.
- Stay silent on everyday logistics ("buy bread" — "ok, tonight"). When unsure between tension and logistics, speak.
- If any NEW message addresses you (marked [to bot]), you must speak.

Translations (field "translations"):
- Translate every NEW text message whose author's language differs from the other partner's language, into the other partner's language. Translate meaning and tone, not word by word. Never add interpretation to a translation.
- Skip messages marked [voice] (they are translated with their transcript) and skip messages already in the listener's language.
- If auto-translate is off, return an empty list.

Safety (field "safety"), judged on the NEW messages in the context of the history:
- "crisis": threats of violence, self-harm or suicide, immediate danger.
- "abuse": signs of control, intimidation, coercion, humiliation or violence in the relationship.
- "concern": distress that needs a gentle check-in, without danger.
- "none": otherwise. Sarcasm, jokes and ordinary heated arguments are "none" or "concern", not "abuse".

Escalation (field "escalation"): true only on a sharp rise of accusations, "always/never" generalisations or personal attacks in the NEW messages.

Reply (field "reply"): one entry per language of the couple, same meaning in each. Empty list when speak is false.`;

export const PAUSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    translations: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          message_id: { type: "INTEGER" },
          lang: { type: "STRING" },
          text: { type: "STRING" },
        },
        required: ["message_id", "lang", "text"],
      },
    },
    safety: { type: "STRING", enum: ["none", "concern", "abuse", "crisis"] },
    speak: { type: "BOOLEAN" },
    addressee_user_id: { type: "INTEGER", nullable: true },
    reply: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { lang: { type: "STRING" }, text: { type: "STRING" } },
        required: ["lang", "text"],
      },
    },
    escalation: { type: "BOOLEAN" },
  },
  required: ["translations", "safety", "speak", "reply", "escalation"],
};

// --- Промпт паузы из группового контекста ---

function memberLine(m) {
  return `- ${m.name ?? `user ${m.userId}`} (id ${m.userId}), language: ${m.lang ?? "unknown"}`;
}

function messageLine(message, members, answeredUpTo) {
  const author = members.find((m) => m.userId === Number(message.author_user_id));
  const who = message.is_bot
    ? author
      ? `${author.name} via bot`
      : "bot"
    : (author?.name ?? `user ${message.author_user_id}`);
  const tags = [];
  if (Number(message.id) > answeredUpTo && !message.is_bot) tags.push("NEW");
  if (message.addresses_bot) tags.push("to bot");
  if (message.kind !== "text") tags.push("voice");
  if (message.scope === "guest") tags.push("private chat of the couple");
  const text = message.text ?? (message.transcript_status === "failed" ? "(voice message, not transcribed)" : "(voice message)");
  return `[${message.id}] ${who}${tags.length ? ` [${tags.join("] [")}]` : ""}: ${text}`;
}

/**
 * @param {object} context результат buildGroupContext
 * @param {number} answeredUpTo маркер: сообщения новее — NEW
 */
export function pausePrompt(context, answeredUpTo) {
  const lines = [
    "Couple:",
    ...context.members.map(memberLine),
    `Auto-translate: ${context.autoTranslate ? "on" : "off"}`,
    `Abuse flag active: ${context.abuseFlagActive ? "yes" : "no"}`,
  ];
  if (context.summaries.group) lines.push("", "Summary of earlier conversation:", context.summaries.group);
  if (context.notes.length) {
    lines.push("", "Notes a partner explicitly allowed you to use (do not quote them verbatim):");
    for (const note of context.notes) lines.push(`- ${note.text}`);
  }
  lines.push("", "Messages (oldest first):");
  for (const message of context.shared) lines.push(messageLine(message, context.members, answeredUpTo));
  return lines.join("\n");
}

// --- Разбор и проверка ответа модели ---

/**
 * Приводит ответ паузы к безопасной форме: неизвестные id переводов
 * отбрасываются, ответ без языка пары не публикуется, @ форсирует speak.
 * @param {object} data ответ модели по PAUSE_SCHEMA
 * @param {object} input { newMessageIds: number[], coupleLangs: string[], addressedToBot: boolean }
 */
export function normalizePause(data, { newMessageIds, coupleLangs, addressedToBot, voiceMessageIds = [] }) {
  const allowed = new Set(newMessageIds.filter((id) => !voiceMessageIds.includes(id)));
  const translations = (data.translations ?? [])
    .filter((t) => allowed.has(Number(t.message_id)) && String(t.text ?? "").trim())
    .map((t) => ({ messageId: Number(t.message_id), lang: t.lang, text: String(t.text).trim() }));

  const byLang = new Map();
  for (const r of data.reply ?? []) {
    const lang = String(r.lang ?? "").split(/[-_]/)[0].toLowerCase();
    if (lang && String(r.text ?? "").trim() && !byLang.has(lang)) byLang.set(lang, String(r.text).trim());
  }
  const reply = coupleLangs.map((lang) => ({ lang, text: byLang.get(lang) })).filter((r) => r.text);

  // Обращение к боту — ответ всегда (DR23). Если модель всё же не дала текст,
  // говорить нечего: вызывающий покажет нейтральный фолбэк.
  const speak = Boolean(data.speak) || addressedToBot;

  return {
    translations,
    safety: ["none", "concern", "abuse", "crisis"].includes(data.safety) ? data.safety : "none",
    speak: speak && reply.length > 0,
    speakRequested: speak,
    addresseeUserId: data.addressee_user_id ?? null,
    reply,
    escalation: Boolean(data.escalation),
  };
}

// --- Личка (premise 2, DR11, DR13) ---
//
// В личке бот — не союзник автора против партнёра, а тот, кто держит в
// разговоре отсутствующего партнёра: помогает понять, что тот мог иметь в
// виду, и сформулировать своё так, чтобы партнёр услышал. Личка второго
// партнёра в контекст не попадает никогда (lib/context.js).

export const DM_SYSTEM = `You are a private conversation helper for one person in a couple, in their direct chat with you. You are not a therapist and never claim to be.

Stance (most important):
- You are "we-first". In this private chat you represent the absent partner: help this person understand what the partner might have meant and feel, always as hypotheses ("maybe…"), never as facts or verdicts.
- Do not simply agree. Acknowledge the feeling briefly, then ask one clarifying question or offer one alternative reading.
- Never quote or reveal anything from the partner's private chat — you do not have it. You may use the shared history and notes.
- No diagnoses, no labels for either partner, no advice to leave or stay.
- If an abuse flag is active: do not "balance both sides", do not push joint exercises; support the person's safety.

Voice: informal "you" (tu/du/ты), at most 4 sentences, one question at most, no emoji, reply in the person's language. None of these phrases or their equivalents: "I hear you", "it's completely normal to feel", "your feelings are valid", "it's important to remember that", "let's figure this out". You refer to yourself with masculine grammatical gender where the language has it.

Safety (field "safety") on the NEW message: "crisis" (threats of violence, self-harm, suicide, immediate danger), "abuse" (control, intimidation, coercion, humiliation or violence in the relationship), "concern" (distress needing a gentle check-in), "none".

Note (field "note_candidate"): if the person said something the partner would benefit from knowing in shared replies (a need, a boundary, a context), propose ONE short neutral note in the person's own words; otherwise null. Never propose notes with secrets, health details or anything that could embarrass them.`;

export const DM_SCHEMA = {
  type: "OBJECT",
  properties: {
    safety: { type: "STRING", enum: ["none", "concern", "abuse", "crisis"] },
    reply: { type: "STRING" },
    note_candidate: { type: "STRING", nullable: true },
  },
  required: ["safety", "reply"],
};

/**
 * @param {object} context результат buildDmContext
 * @param {{name: string, lang: string}} owner
 * @param {{name: string, lang: string}|null} partner
 */
export function dmPrompt(context, owner, partner) {
  const lines = [
    `You talk with: ${owner.name ?? "the person"} (language: ${owner.lang ?? "unknown"}).`,
    partner ? `Their partner: ${partner.name ?? "the partner"} (language: ${partner.lang ?? "unknown"}).` : "Partner: not available right now.",
    `Abuse flag active: ${context.abuseFlagActive ? "yes" : "no"}`,
  ];
  if (context.summaries.group) lines.push("", "Summary of the shared conversation:", context.summaries.group);
  if (context.shared.length) {
    lines.push("", "Recent shared group messages:");
    for (const m of context.shared) lines.push(`- ${m.is_bot ? "bot" : Number(m.author_user_id) === Number(context.ownerUserId) ? owner.name : (partner?.name ?? "partner")}: ${m.text ?? "(voice)"}`);
  }
  if (context.notes.length) {
    lines.push("", "Notes allowed for shared replies:");
    for (const n of context.notes) lines.push(`- ${n.text}`);
  }
  if (context.summaries.dm) lines.push("", "Summary of your earlier private conversation:", context.summaries.dm);
  lines.push("", "Your private conversation (oldest first, last one is NEW):");
  for (const m of context.dm) lines.push(`${m.is_bot ? "you" : owner.name}: ${m.text ?? "(voice)"}`);
  return lines.join("\n");
}

export function normalizeDm(data) {
  return {
    safety: ["none", "concern", "abuse", "crisis"].includes(data.safety) ? data.safety : "none",
    reply: String(data.reply ?? "").trim(),
    noteCandidate: data.note_candidate ? String(data.note_candidate).trim().slice(0, 500) || null : null,
  };
}

// --- Guest Mode (DR12) ---
//
// Ответ в 2–3 строки: формулировка или перевод, одно-два возможных прочтения
// как гипотезы, вопрос автору фразы по имени. В неподтверждённом чате (не
// личка пары) — только формулировка и граница знания, без обращения к партнёру.

export const GUEST_SYSTEM = `You are summoned inside a private chat by one person of a couple, to help with one message.
Return JSON {"safety", "lines": [{"lang", "text"}]}.
Confirmed couple chat: for each language given, 2–3 short lines: (1) a plain rephrasing or translation of the replied-to message; (2) one or two possible readings, each as a hypothesis ("maybe…"); (3) a question to the author of the replied-to message, by name ("María, did I get it right?"). Never a verdict, never who is right.
Unconfirmed chat: only a rephrasing or translation in the caller's language plus one line saying only the author can clarify what they meant. No hypotheses about anyone, no names.
No emoji. You refer to yourself with masculine grammatical gender where the language has it.
Safety: "crisis" (violence, self-harm, immediate danger), "abuse" (control, intimidation, coercion), "concern", "none".`;

export const GUEST_SCHEMA = {
  type: "OBJECT",
  properties: {
    safety: { type: "STRING", enum: ["none", "concern", "abuse", "crisis"] },
    lines: {
      type: "ARRAY",
      items: { type: "OBJECT", properties: { lang: { type: "STRING" }, text: { type: "STRING" } }, required: ["lang", "text"] },
    },
  },
  required: ["safety", "lines"],
};

export function guestPrompt({ confirmed, caller, author, langs, summoning, repliedTo, context }) {
  const lines = [
    `Chat: ${confirmed ? "confirmed private chat of the couple" : "unconfirmed chat (not the couple's own chat)"}`,
    `Languages to answer in: ${langs.join(", ")}`,
    `Caller: ${caller.name ?? "the caller"}`,
  ];
  if (confirmed && context) {
    if (context.summaries.group) lines.push("", "Summary of the couple's shared conversation:", context.summaries.group);
    for (const n of context.notes) lines.push(`Note: ${n.text}`);
  }
  lines.push("", `Summoning message: ${summoning ?? ""}`);
  if (repliedTo) lines.push(`Replied-to message${author?.name ? ` by ${author.name}` : ""}: ${repliedTo}`);
  return lines.join("\n");
}
