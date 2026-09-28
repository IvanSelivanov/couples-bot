// Черновики из лички: «переводчик со злого» и публикация в группу (DR10).
//
// Сейчас здесь только публикация с защитой от двойной отправки (R13, T7):
//   «Отправить» ─▶ editing → sending (условный UPDATE) ─ не вышло ─▶ ничего
//                        │                                (двойной клик)
//                        ▼
//                    deliver через outbox, ключ draft:<id>
//                        ├ sent     ─▶ черновик удаляется целиком
//                        ├ unknown  ─▶ статус unknown, автору «проверь группу»
//                        └ failed   ─▶ обратно editing, автору «не отправилось»
// Создание, правка и превью черновика (DR10) — в следующих задачах.

import * as db from "./db.js";
import { deliver as deliverOutbound, sendMessage } from "./telegram.js";

// Тексты для автора — черновые, на русском; каталог lib/copy/ появится в T15.
export const UNKNOWN_DELIVERY_TEXT = "Не удалось подтвердить доставку. Проверь группу перед повторной отправкой.";
export const FAILED_DELIVERY_TEXT = "Сообщение не отправилось. Черновик сохранён, можно попробовать ещё раз.";

/**
 * @param {object} draft
 * @param {number} draft.draftId
 * @param {number} draft.userId автор; его личка — куда писать о результате
 * @param {number} draft.coupleId
 * @param {number} draft.groupChatId
 * @param {object} draft.params параметры sendMessage для группы (готовый формат DR10)
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
      await notify(draft.userId, UNKNOWN_DELIVERY_TEXT);
      break;
    case "failed":
      await store.draftSetStatus(draft.draftId, "editing");
      await notify(draft.userId, FAILED_DELIVERY_TEXT);
      break;
  }
  return outcome.status;
}
