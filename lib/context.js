// ЕДИНСТВЕННОЕ место сборки контекста для модели (дизайн-док, «Граница в
// коде»; R15). Граница данных:
//
//   контекст     | сводки              | сообщения                  | заметки
//   -------------+---------------------+----------------------------+-------------------
//   group/guest  | group               | group + guest (40)         | активные, обоих
//   dm X         | dm:X, group         | dm X (40), group+guest (40)| активные, обоих
//   dm X, когда  | dm:X                | dm X (40)                  | нет
//   Y отозвал    |                     |                            |
//
// Никогда: личка Y, сводка dm:Y, черновики — ни в каком контексте.
// Заметки не входят в сводки и читаются заново на каждый вызов, поэтому
// отозванная заметка пропадает из следующего контекста сразу (R15).
//
// Текст лички и сводки dm:* лежат шифротекстом с aad "dm:<владелец>":
// строку чужой лички нельзя расшифровать под чужим владельцем.

import { contextReads } from "./db.js";
import { decrypt } from "./crypto.js";

export const CONTEXT_MESSAGES = 40;

export class ContextRefused extends Error {}

const dmAad = (userId) => `dm:${userId}`;

function openDmMessage(row, ownerUserId) {
  return { ...row, text: row.text === null ? null : decrypt(row.text, dmAad(ownerUserId)) };
}

/**
 * Контекст общей поверхности: ответ ведущего, @, Guest Mode.
 * Пара должна быть active: в остальных состояниях бот в группе молчит.
 */
export async function buildGroupContext(coupleId, { reads = contextReads } = {}) {
  const couple = await reads.couple(coupleId);
  if (!couple) throw new ContextRefused("пары нет");
  if (couple.state !== "active") throw new ContextRefused(`пара в состоянии ${couple.state}`);

  const [summary, messages, notes, members, abuseFlagActive] = await Promise.all([
    reads.summary(coupleId, "group"),
    reads.sharedMessages(coupleId, CONTEXT_MESSAGES),
    reads.activeNotes(coupleId),
    reads.members(coupleId),
    reads.abuseFlagActive(coupleId),
  ]);

  return {
    surface: "group",
    coupleId,
    groupChatId: couple.group_chat_id,
    autoTranslate: couple.auto_translate,
    stateVersion: couple.state_version,
    members: members.map((m) => ({ userId: Number(m.user_id), lang: m.lang, name: m.display_name, tz: m.tz })),
    abuseFlagActive,
    summaries: { group: summary?.text ?? null },
    shared: messages,
    dm: [],
    notes,
  };
}

/**
 * Контекст лички владельца ownerUserId.
 * Если согласие отозвал сам владелец — отказ (личка отвечает только на
 * /consent и /forget). Если отозвал партнёр — только своя личка: общая
 * история и заметки содержат данные партнёра.
 */
export async function buildDmContext(coupleId, ownerUserId, { reads = contextReads } = {}) {
  const [couple, members] = await Promise.all([reads.couple(coupleId), reads.members(coupleId)]);
  if (!couple) throw new ContextRefused("пары нет");

  const owner = members.find((m) => Number(m.user_id) === Number(ownerUserId));
  if (!owner) throw new ContextRefused("не участник пары");
  if (owner.revoked_at) throw new ContextRefused("владелец отозвал согласие");

  const partnerRevoked = members.some((m) => Number(m.user_id) !== Number(ownerUserId) && m.revoked_at);

  const dmSummaryRow = await reads.summary(coupleId, dmAad(ownerUserId));
  const dmRows = await reads.dmMessages(coupleId, ownerUserId, CONTEXT_MESSAGES);
  const dm = dmRows.map((row) => openDmMessage(row, ownerUserId));
  const dmSummary = dmSummaryRow ? decrypt(dmSummaryRow.text, dmAad(ownerUserId)) : null;

  if (partnerRevoked) {
    return {
      surface: "dm",
      ownerUserId,
      stateVersion: couple.state_version,
      summaries: { dm: dmSummary, group: null },
      shared: [],
      dm,
      notes: [],
    };
  }

  const [groupSummary, shared, notes] = await Promise.all([
    reads.summary(coupleId, "group"),
    reads.sharedMessages(coupleId, CONTEXT_MESSAGES),
    reads.activeNotes(coupleId),
  ]);

  return {
    surface: "dm",
    ownerUserId,
    stateVersion: couple.state_version,
    summaries: { dm: dmSummary, group: groupSummary?.text ?? null },
    shared,
    dm,
    notes,
  };
}
