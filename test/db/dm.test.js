// T23: помощник в личке сквозь живую базу. Модель и Telegram подменены.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleUpdate } from "../../lib/handle.js";
import { connect, truncateAll, useLocalSupabase } from "./helpers.js";

const sql = connect();
beforeAll(() => {
  useLocalSupabase();
  process.env.DM_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.DM_ENCRYPTION_KEY_VERSION = "1";
});
afterAll(() => sql.end());

const X = 51;
const Y = 62;
let updateId = 8000;
let messageId = 1;

beforeEach(async () => {
  await truncateAll(sql);
  const [c] = await sql`insert into couples (group_chat_id, state) values (-888, 'active') returning id`;
  await sql`insert into members (user_id, couple_id, lang, display_name, onboarding_step, consented_at) values
    (${X}, ${c.id}, 'ru', 'Иван', 'done', now()), (${Y}, ${c.id}, 'es', 'María', 'done', now())`;
});

function env(generateResult) {
  const sent = [];
  return {
    sent,
    env: {
      text: async (lang, key) => `${lang}:${key}`,
      deliver: vi.fn(async (m) => {
        sent.push(m);
        return { status: "sent", tgMessageId: 6000 + sent.length };
      }),
      api: vi.fn().mockResolvedValue(true),
      generate: vi.fn().mockResolvedValue(generateResult),
      onSafety: vi.fn(),
      defer: () => {},
    },
  };
}

const dm = (from, text) => ({
  update_id: updateId++,
  message: { message_id: messageId++, chat: { id: from, type: "private" }, from: { id: from, language_code: "ru" }, text },
});

describe("личка", () => {
  it("реплика шифруется, ответ с кнопкой «Сформулировать партнёру», ответ бота тоже сохраняется", async () => {
    const h = env({ ok: true, data: { safety: "none", reply: "Что именно задело?", note_candidate: null } });
    expect(await handleUpdate(dm(X, "Она опять опоздала"), h.env)).toBe("dm_reply");
    expect(h.sent[0].params.text).toBe("Что именно задело?");
    expect(h.sent[0].params.reply_markup.inline_keyboard[0][0]).toEqual({ text: "ru:draft.compose_button", callback_data: "dr:compose" });

    const rows = await sql`select is_bot, text from messages where scope = 'dm' and owner_user_id = ${X} order by id`;
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.text.startsWith("v1.")).toBe(true);
      expect(r.text).not.toContain("опоздала");
    }
    expect(h.env.generate.mock.calls[0][0].purpose).toBe("dm_reply");
    expect(h.env.generate.mock.calls[0][0].parts[0].text).toContain("Она опять опоздала");
  });

  it("строки лички старше 6 дней удаляются при новом сообщении, без cron (R27)", async () => {
    const [c] = await sql`select id from couples`;
    await sql`insert into messages (couple_id, scope, owner_user_id, author_user_id, text, created_at)
      values (${c.id}, 'dm', ${X}, ${X}, 'старое', now() - interval '6 days 1 minute'),
             (${c.id}, 'dm', ${Y}, ${Y}, 'чужое старое', now() - interval '8 days')`;
    await handleUpdate(dm(X, "новое"), env({ ok: true, data: { safety: "none", reply: "да" } }).env);
    const left = await sql`select owner_user_id, text from messages where scope = 'dm' and text = 'старое'`;
    expect(left).toHaveLength(0);
    // Удаление только своих строк: чужую личку удалит её собственное сообщение или cron.
    expect(await sql`select id from messages where text = 'чужое старое'`).toHaveLength(1);
  });

  it("кризис: набор помощи только автору, ответа модели нет", async () => {
    const h = env({ ok: true, data: { safety: "crisis", reply: "что-то" } });
    expect(await handleUpdate(dm(X, "не хочу жить"), h.env)).toBe("dm_crisis");
    expect(h.env.onSafety).toHaveBeenCalledWith(expect.objectContaining({ signal: "crisis", surface: "dm", fromUserId: X }));
    expect(h.sent).toHaveLength(0);
  });

  it("абьюз: сигнал автору и поддерживающий ответ", async () => {
    const h = env({ ok: true, data: { safety: "abuse", reply: "Ты в безопасности сейчас?" } });
    await handleUpdate(dm(X, "он проверяет мой телефон и запрещает видеться с друзьями"), h.env);
    expect(h.env.onSafety).toHaveBeenCalledWith(expect.objectContaining({ signal: "abuse", surface: "dm" }));
    expect(h.sent[0].params.text).toBe("Ты в безопасности сейчас?");
  });

  it("сбой модели — фолбэк лички и «Срочная помощь: /help» (DR14)", async () => {
    const h = env({ unavailable: "quota", reason: "level" });
    await handleUpdate(dm(X, "привет"), h.env);
    expect(h.sent[0].params.text).toBe("ru:fallback.dm\n\nru:fallback.urgent_help");
  });

  it("повтор апдейта не отвечает второй раз", async () => {
    const h = env({ ok: true, data: { safety: "none", reply: "да" } });
    const u = dm(X, "раз");
    await handleUpdate(u, h.env);
    expect(await handleUpdate(u, h.env)).toBe("duplicate");
    expect(h.env.generate).toHaveBeenCalledTimes(1);
  });
});
