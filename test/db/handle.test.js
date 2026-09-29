// Group routing end to end on a live database: intake, commands, /check, voice.
// Model and Telegram are stubbed, the database is real.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleUpdate } from "../../lib/handle.js";
import { connect, truncateAll, useLocalSupabase } from "./helpers.js";

const sql = connect();
beforeAll(useLocalSupabase);
afterAll(() => sql.end());

const CHAT = -555;
const X = 11;
const Y = 22;
let coupleId;
let updateId = 1000;
let tgMessageId = 1;

beforeEach(async () => {
  await truncateAll(sql);
  const [c] = await sql`insert into couples (group_chat_id, state) values (${CHAT}, 'active') returning id`;
  coupleId = c.id;
  await sql`insert into members (user_id, couple_id, lang, display_name, consented_at) values
    (${X}, ${coupleId}, 'ru', 'Иван', now()), (${Y}, ${coupleId}, 'es', 'María', now())`;
});

function env() {
  const sent = [];
  const deferred = [];
  const e = {
    defer: (p) => deferred.push(p),
    text: async (lang, key) => `${lang}:${key}`,
    deliver: vi.fn(async (m) => {
      sent.push(m);
      return { status: "sent", tgMessageId: 7000 + sent.length };
    }),
    api: vi.fn().mockResolvedValue(true),
    transcribe: async () => ({
      ok: true,
      transcript: "Купи хлеб",
      lang: "ru",
      summary: "",
      charged: false,
      translation: "Compra pan",
      usage: 0.1,
    }),
    translateParaphrase: async (t) => t,
    botUsername: "couples_test_bot",
  };
  return { sent, deferred, env: e };
}

const groupMessage = (from, extra = {}) => ({
  update_id: updateId++,
  message: { message_id: tgMessageId++, chat: { id: CHAT, type: "supergroup" }, from: { id: from, is_bot: false }, ...extra },
});

describe("реплики", () => {
  it("текст участника сохраняется и ставит проверку дебаунса", async () => {
    const h = env();
    expect(await handleUpdate(groupMessage(X, { text: "Ты опять опоздала" }), h.env)).toBe("text");
    const rows = await sql`select text, addresses_bot from messages where couple_id = ${coupleId}`;
    expect(rows).toEqual([{ text: "Ты опять опоздала", addresses_bot: false }]);
    expect(h.deferred.length).toBeGreaterThan(0);
  });

  it("обращение к боту помечается (DR23)", async () => {
    const h = env();
    await handleUpdate(groupMessage(Y, { text: "@couples_test_bot ¿qué quiso decir?" }), h.env);
    const [row] = await sql`select addresses_bot from messages where couple_id = ${coupleId}`;
    expect(row.addresses_bot).toBe(true);
  });

  it("посторонний не сохраняется", async () => {
    expect(await handleUpdate(groupMessage(99, { text: "привет" }), env().env)).toBe("not_member");
    expect(await sql`select id from messages`).toHaveLength(0);
  });

  it("на паузе реплики не сохраняются (DR3)", async () => {
    await sql`update couples set state = 'paused', paused_by = ${X} where id = ${coupleId}`;
    expect(await handleUpdate(groupMessage(Y, { text: "hola" }), env().env)).toBe("ignored_paused");
    expect(await sql`select id from messages`).toHaveLength(0);
  });

  it("повтор того же апдейта — duplicate", async () => {
    const h = env();
    const u = groupMessage(X, { text: "раз" });
    await handleUpdate(u, h.env);
    expect(await handleUpdate(u, h.env)).toBe("duplicate");
  });
});

describe("команды", () => {
  it("/pause и /resume чужим — «паузу снимет тот, кто её поставил»", async () => {
    const h = env();
    await handleUpdate(groupMessage(X, { text: "/pause" }), h.env);
    await handleUpdate(groupMessage(Y, { text: "/resume" }), h.env);
    const texts = h.sent.map((m) => m.params.text);
    expect(texts[0]).toContain("state.paused");
    expect(texts[1]).toContain("state.resume_not_pauser");
    const [c] = await sql`select state from couples where id = ${coupleId}`;
    expect(c.state).toBe("paused");
  });

  it("/translate переключает перевод", async () => {
    const h = env();
    await handleUpdate(groupMessage(Y, { text: "/translate@couples_test_bot" }), h.env);
    const [c] = await sql`select auto_translate from couples where id = ${coupleId}`;
    expect(c.auto_translate).toBe(false);
    expect(h.sent[0].params.text).toContain("translate.off");
  });

  it("/help — справка и набор помощи без модели", async () => {
    const h = env();
    await handleUpdate(groupMessage(X, { text: "/help" }), h.env);
    expect(h.sent[0].params.text).toContain("help.group");
    expect(h.sent[0].params.text).toContain("findahelpline.com");
  });
});

describe("/check сквозь кнопки", () => {
  it("старт → просьба пересказать с «Пропустить» → нажатие слушающего закрывает", async () => {
    const h = env();
    await handleUpdate(groupMessage(X, { text: "/check" }), h.env);
    const ask = h.sent[0];
    expect(ask.params.text).toContain("María, es:check.ask_paraphrase");
    expect(ask.params.reply_markup.inline_keyboard[0][0]).toEqual({ text: "es:check.skip_button", callback_data: "chk:skip" });
    const [k] = await sql`select prompt_message_id from checks where couple_id = ${coupleId}`;
    expect(Number(k.prompt_message_id)).toBe(7001);

    const callback = {
      update_id: updateId++,
      callback_query: { id: "cb1", from: { id: Y }, data: "chk:skip", message: { message_id: 7001, chat: { id: CHAT } } },
    };
    expect(await handleUpdate(callback, h.env)).toBe("check");
    const [ended] = await sql`select outcome from checks where couple_id = ${coupleId}`;
    expect(ended.outcome).toBe("skipped");
  });

  it("чужое нажатие — всплывающее «для <имя>»", async () => {
    const h = env();
    await handleUpdate(groupMessage(X, { text: "/check" }), h.env);
    const callback = {
      update_id: updateId++,
      callback_query: { id: "cb2", from: { id: X }, data: "chk:skip", message: { message_id: 7001, chat: { id: CHAT } } },
    };
    await handleUpdate(callback, h.env);
    const popup = h.env.api.mock.calls.find(([method]) => method === "answerCallbackQuery");
    expect(popup).toBeDefined();
  });
});

describe("голосовые", () => {
  it("голосовое: pending → транскрипт с переводом реплаем → done", async () => {
    const h = env();
    const u = groupMessage(X, { voice: { file_id: "f", duration: 12 } });
    expect(await handleUpdate(u, h.env)).toBe("voice");
    const transcript = h.sent.find((m) => m.key.startsWith("voice:"));
    expect(transcript.params.text).toContain("RU ▸ Купи хлеб");
    expect(transcript.params.text).toContain("ES ▸ Compra pan");
    expect(transcript.params.reply_parameters).toEqual({ message_id: u.message.message_id });
    const [m] = await sql`select transcript_status, text from messages where couple_id = ${coupleId}`;
    expect(m).toEqual({ transcript_status: "done", text: "Купи хлеб" });
  });
});
