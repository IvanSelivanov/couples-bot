// Маршрутизация апдейтов: группа, Guest Mode, личка, кнопки, сервисные.
// Не знает ни про вебхук, ни про очередь, ни про waitUntil: её зовут
// одинаково из очереди, фолбэка и локального polling.
//
// Сейчас это каркас приёма (T5). Обработчики поверхностей появятся в
// следующих задачах; до тех пор апдейт только логируется по типу.

export const ALLOWED_UPDATES = ["message", "callback_query", "guest_message", "my_chat_member"];

export function updateKind(update) {
  return ALLOWED_UPDATES.find((kind) => update[kind] !== undefined) ?? "other";
}

export async function handleUpdate(update) {
  // Без текста: только тип и id.
  console.log(`[handle] ${updateKind(update)} ${update.update_id}`);
}
