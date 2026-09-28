// Онбординг группы и контроль состава (R17; D18, D5).
//
// Бот обязан быть администратором группы: админ получает все сообщения
// группы независимо от privacy mode и может надёжно видеть состав через
// getChatMember. Удалять и банить боту не нужно — прав сверх статуса не просим.
//
// Состав: в группе ровно трое — бот и двое участников пары. Третий человек
// или потеря админки → пара suspended, бот объясняет и молчит; состав
// восстановлен → restore. Изменения состава видны по служебным сообщениям
// (new_chat_members, left_chat_member) и по my_chat_member для самого бота.
//
// getMe.can_read_all_group_messages больше не блокирует регистрацию (R17
// заменил D5): только строка диагностики в логе.
//
// Первое сообщение, согласия и статус (DR7, DR8) — в следующих задачах.

import { call } from "./telegram.js";
import { coupleTransition } from "./db.js";

const PRESENT = new Set(["creator", "administrator", "member", "restricted"]);

/**
 * Готова ли группа: бот — админ, в группе ровно пара и бот.
 * @param {number} chatId
 * @param {number[]} memberIds user_id участников пары, которые уже известны (0–2)
 * @returns {Promise<{ok: true} | {ok: false, reason: "not_admin"|"wrong_count"|"member_missing", count?: number}>}
 */
export async function checkGroup(chatId, memberIds, { api = call } = {}) {
  const me = await api("getMe", {});
  if (me.can_read_all_group_messages !== true) {
    console.warn("[onboarding] privacy mode включён; бот-админ всё равно видит все сообщения");
  }

  const botMember = await api("getChatMember", { chat_id: chatId, user_id: me.id });
  if (botMember.status !== "administrator") return { ok: false, reason: "not_admin" };

  const count = await api("getChatMemberCount", { chat_id: chatId });
  if (count !== 3) return { ok: false, reason: "wrong_count", count };

  for (const userId of memberIds) {
    const member = await api("getChatMember", { chat_id: chatId, user_id: userId });
    if (!PRESENT.has(member.status)) return { ok: false, reason: "member_missing" };
  }
  return { ok: true };
}

// Эффект для пользователя: ключ текста из таблицы состояний DR3.
const SUSPEND_TEXT_KEY = {
  not_admin: "state.suspended_not_admin",
  wrong_count: "state.suspended_third_member",
  member_missing: "state.suspended_third_member",
};

/**
 * Перепроверка состава после события в группе. Возвращает эффекты.
 * @param {object} couple { id, groupChatId, state, memberIds }
 */
export async function recheckComposition(couple, { api = call, transition = coupleTransition } = {}) {
  const result = await checkGroup(couple.groupChatId, couple.memberIds, { api });

  if (!result.ok && (couple.state === "active" || couple.state === "paused")) {
    const t = await transition(couple.id, "suspend");
    return t.ok ? [{ type: "say", key: SUSPEND_TEXT_KEY[result.reason] }] : [];
  }
  if (result.ok && couple.state === "suspended") {
    const t = await transition(couple.id, "restore");
    return t.ok ? [{ type: "say", key: "state.restored", to: t.to }] : [];
  }
  return [];
}

// Апдейт меняет состав группы или права бота — нужна перепроверка.
export function affectsComposition(update) {
  const message = update.message;
  if (message?.new_chat_members?.length || message?.left_chat_member) return true;
  return update.my_chat_member !== undefined;
}
