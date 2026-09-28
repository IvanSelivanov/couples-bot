// T23 часть 2: черновики (DR10) и заметки (DR11, R15) сквозь живую базу.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleUpdate } from "../../lib/handle.js";
import { buildGroupContext } from "../../lib/context.js";
import { connect, truncateAll, useLocalSupabase } from "./helpers.js";

const sql = connect();
beforeAll(() => {
  useLocalSupabase();
  process.env.DM_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.DM_ENCRYPTION_KEY_VERSION = "1";
});
afterAll(() => sql.end());

const X = 71;
const Y = 82;
const CHAT = -999;
let coupleId;
let updateId = 12000;
let messageId = 1;

beforeEach(async () => {
  await truncateAll(sql);
  const [c] = await sql`insert into couples (group_chat_id, state) values (${CHAT}, 'active') returning id`;
  coupleId = c.id;
  await sql`insert into members (user_id, couple_id, lang, display_name, onboarding_step, consented_at) values
    (${X}, ${coupleId}, 'ru', 'Иван', 'done', now()), (${Y}, ${coupleId}, 'es', 'María', 'done', now())`;
});

function env({ generate } = {}) {
  const sent = [];
  return {
    sent,
    env: {
      text: async (lang, key, params) => `${lang}:${key}${params?.name ? `(${params.name})` : ""}`,
      deliver: vi.fn(async (m) => {
        sent.push(m);
        return { status: "sent", tgMessageId: 4000 + sent.length };
      }),
      api: vi.fn().mockResolvedValue(true),
      generate:
        generate ??
        vi.fn(async ({ purpose }) =>
          purpose === "draft"
            ? { ok: true, data: { partner_text: "Me dolió que llegaras tarde", author_meaning: "Мне было больно, что ты опоздала" } }
            : { ok: true, data: { safety: "none", reply: "Понимаю", note_candidate: null } },
        ),
      onSafety: vi.fn(),
      defer: () => {},
    },
  };
}

const dm = (text) => ({
  update_id: updateId++,
  message: { message_id: messageId++, chat: { id: X, type: "private" }, from: { id: X, language_code: "ru" }, text },
});
const tap = (data) => ({
  update_id: updateId++,
  callback_query: { id: `c${updateId}`, from: { id: X }, data, message: { message_id: 1, chat: { id: X, type: "private" } } },
});
const draftId = async () => Number((await sql`select id from drafts where user_id = ${X}`)[0]?.id);

describe("черновик (DR10)", () => {
  it("/draft с текстом: превью сначала для партнёра, потом смысл для автора; черновик шифрован", async () => {
    const h = env();
    expect(await handleUpdate(dm("/draft ты опять опоздала, достало"), h.env)).toBe("draft_start");
    const preview = h.sent.at(-1).params;
    expect(preview.text.indexOf("Me dolió")).toBeLessThan(preview.text.indexOf("Мне было больно"));
    expect(preview.reply_markup.inline_keyboard.flat().map((b) => b.callback_data)).toEqual([
      `dr:send:${await draftId()}`,
      `dr:edit:${await draftId()}`,
      `dr:del:${await draftId()}`,
    ]);
    const [row] = await sql`select original, reformulated from drafts where user_id = ${X}`;
    expect(row.original).not.toContain("опоздала");
    expect(row.reformulated).not.toContain("dolió");
  });

  it("кнопка без текста: бот спрашивает, следующая реплика становится черновиком", async () => {
    const h = env();
    await handleUpdate(tap("dr:compose"), h.env);
    expect(h.sent.at(-1).params.text).toBe("ru:draft.ask_text");
    expect(await handleUpdate(dm("ты опять опоздала"), h.env)).toBe("draft_text");
    expect(h.sent.at(-1).params.text).toContain("Me dolió");
  });

  it("отправка: в группе шапка и текст на языке партнёра, черновик удалён целиком, текст в общей истории", async () => {
    const h = env();
    await handleUpdate(dm("/draft ты опять опоздала"), h.env);
    const id = await draftId();
    expect(await handleUpdate(tap(`dr:send:${id}`), h.env)).toBe("draft_send");
    const group = h.sent.find((m) => m.key === `draft:${id}`);
    expect(group.chatId).toBe(CHAT);
    expect(group.params.text).toContain("es:draft.header(Иван)");
    expect(group.params.text).toContain("Me dolió que llegaras tarde");
    expect(await sql`select id from drafts where user_id = ${X}`).toHaveLength(0);
    const shared = await sql`select is_bot, author_user_id, text from messages where scope = 'group'`;
    expect(shared).toEqual([{ is_bot: true, author_user_id: expect.anything(), text: "Me dolió que llegaras tarde" }]);
  });

  it("двойное нажатие «Отправить» публикует один раз", async () => {
    const h = env();
    await handleUpdate(dm("/draft ты опять опоздала"), h.env);
    const id = await draftId();
    await Promise.all([handleUpdate(tap(`dr:send:${id}`), h.env), handleUpdate(tap(`dr:send:${id}`), h.env)]);
    expect(h.sent.filter((m) => m.key === `draft:${id}`)).toHaveLength(1);
  });

  it("«Изменить текст»: пожелание → новое превью", async () => {
    const h = env();
    await handleUpdate(dm("/draft ты опять опоздала"), h.env);
    await handleUpdate(tap(`dr:edit:${await draftId()}`), h.env);
    expect(h.sent.at(-1).params.text).toBe("ru:draft.ask_edit");
    await handleUpdate(dm("помягче"), h.env);
    const call = h.env.generate.mock.calls.at(-1)[0];
    expect(call.parts.at(-1).text).toContain("помягче");
  });

  it("«Удалить» — черновик нигде не остаётся", async () => {
    const h = env();
    await handleUpdate(dm("/draft ты опять опоздала"), h.env);
    await handleUpdate(tap(`dr:del:${await draftId()}`), h.env);
    expect(await sql`select id from drafts`).toHaveLength(0);
    expect(h.sent.some((m) => m.chatId === CHAT)).toBe(false);
  });

  it("на паузе отправить нельзя", async () => {
    const h = env();
    await handleUpdate(dm("/draft ты опять опоздала"), h.env);
    await sql`update couples set state = 'paused' where id = ${coupleId}`;
    await handleUpdate(tap(`dr:send:${await draftId()}`), h.env);
    expect(h.sent.at(-1).params.text).toBe("ru:draft.not_active");
  });
});

describe("заметки (DR11, R15)", () => {
  const withNote = () =>
    env({
      generate: vi.fn(async () => ({ ok: true, data: { safety: "none", reply: "Понимаю", note_candidate: "Мне важно, чтобы о задержках предупреждали" } })),
    });
  const noteId = async () => Number((await sql`select id from notes where author_user_id = ${X}`)[0]?.id);

  it("предложение с точным текстом и тремя кнопками; до одобрения текст шифрован и не в контексте", async () => {
    const h = withNote();
    await handleUpdate(dm("она опоздала"), h.env);
    const offer = h.sent.at(-1).params;
    expect(offer.text).toContain("ru:notes.offer");
    expect(offer.text).toContain("Мне важно, чтобы о задержках предупреждали");
    const [n] = await sql`select text, approved_at from notes`;
    expect(n.text.startsWith("v1.")).toBe(true);
    expect(JSON.stringify(await buildGroupContext(coupleId))).not.toContain("предупреждали");
  });

  it("не чаще раза за 30 минут", async () => {
    const h = withNote();
    await handleUpdate(dm("раз"), h.env);
    await handleUpdate(dm("два"), h.env);
    expect(await sql`select id from notes`).toHaveLength(1);
  });

  it("«Разрешить» — открытый текст в общем контексте; /notes и «Отозвать» — стирается сразу", async () => {
    const h = withNote();
    await handleUpdate(dm("она опоздала"), h.env);
    await handleUpdate(tap(`nt:allow:${await noteId()}`), h.env);
    expect(JSON.stringify(await buildGroupContext(coupleId))).toContain("предупреждали");

    await handleUpdate(dm("/notes"), h.env);
    expect(h.sent.at(-1).params.reply_markup.inline_keyboard.flat()[0].callback_data).toBe(`nt:revoke:${await noteId()}`);
    await handleUpdate(tap(`nt:revoke:${await noteId()}`), h.env);
    expect(h.sent.at(-1).params.text).toBe("ru:notes.revoked");
    expect(JSON.stringify(await buildGroupContext(coupleId))).not.toContain("предупреждали");
    const [n] = await sql`select text, revoked_at from notes`;
    expect(n.text).toBeNull();
  });

  it("«Изменить» — следующая реплика становится новым текстом предложения", async () => {
    const h = withNote();
    await handleUpdate(dm("она опоздала"), h.env);
    await handleUpdate(tap(`nt:edit:${await noteId()}`), h.env);
    expect(await handleUpdate(dm("Прошу предупреждать о задержках"), h.env)).toBe("note_text");
    expect(h.sent.at(-1).params.text).toContain("Прошу предупреждать о задержках");
  });

  it("«Не разрешать» — заметка удалена", async () => {
    const h = withNote();
    await handleUpdate(dm("она опоздала"), h.env);
    await handleUpdate(tap(`nt:deny:${await noteId()}`), h.env);
    expect(await sql`select id from notes`).toHaveLength(0);
  });

  it("пустой список", async () => {
    const h = env();
    await handleUpdate(dm("/notes"), h.env);
    expect(h.sent.at(-1).params.text).toBe("ru:notes.empty");
  });
});
