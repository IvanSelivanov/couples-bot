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
  const who = message.is_bot ? "bot" : (author?.name ?? `user ${message.author_user_id}`);
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
