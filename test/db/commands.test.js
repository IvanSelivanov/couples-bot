// T22: private chat commands and menu end to end on a live database (DR16, DR19, DR20, R25).
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

const X = 91;
const Y = 92;
const CHAT = -4242;
let coupleId;
let updateId = 20000;
let messageId = 1;

beforeEach(async () => {
  await truncateAll(sql);
  const [c] = await sql`insert into couples (group_chat_id, state) values (${CHAT}, 'active') returning id`;
  coupleId = c.id;
  await sql`insert into members (user_id, couple_id, lang, display_name, onboarding_step, consented_at) values
    (${X}, ${coupleId}, 'ru', 'Иван', 'done', now()), (${Y}, ${coupleId}, 'es', 'María', 'done', now())`;
});

function env() {
  const sent = [];
  return {
    sent,
    env: {
      text: async (lang, key) => `${lang}:${key}`,
      deliver: vi.fn(async (m) => {
        sent.push(m);
        return { status: "sent", tgMessageId: 3000 + sent.length };
      }),
      api: vi.fn().mockResolvedValue(true),
      generate: vi.fn().mockResolvedValue({ ok: true, data: { safety: "none", reply: "ok" } }),
      defer: () => {},
    },
  };
}

const dm = (from, text) => ({
  update_id: updateId++,
  message: { message_id: messageId++, chat: { id: from, type: "private" }, from: { id: from }, text },
});
const tap = (from, data) => ({
  update_id: updateId++,
  callback_query: { id: `m${updateId}`, from: { id: from }, data, message: { message_id: 1, chat: { id: from, type: "private" } } },
});
const buttons = (m) => m.params.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);

describe("меню (DR16)", () => {
  it("/menu — четыре раздела", async () => {
    const h = env();
    await handleUpdate(dm(X, "/menu"), h.env);
    expect(buttons(h.sent.at(-1))).toEqual(["dr:compose", "mn:notes", "mn:data", "mn:help"]);
  });

  it("на своей паузе меню предлагает «Снять паузу» первой", async () => {
    await sql`update couples set state = 'paused', paused_by = ${X} where id = ${coupleId}`;
    const h = env();
    await handleUpdate(dm(X, "/menu"), h.env);
    expect(buttons(h.sent.at(-1))[0]).toBe("mn:do:resume");
  });

  it("«Данные и доступ»", async () => {
    const h = env();
    await handleUpdate(tap(X, "mn:data"), h.env);
    expect(buttons(h.sent.at(-1))).toEqual(["mn:ask:forget", "mn:ask:forget_group", "mn:ask:revoke", "mn:do:flag_clear", "mn:do:pause"]);
  });
});

describe("удаления", () => {
  it("/forget: подтверждение с перечнем и «нельзя отменить», затем удаление своего", async () => {
    await sql`insert into messages (couple_id, scope, owner_user_id, author_user_id, text) values
      (${coupleId}, 'dm', ${X}, ${X}, 'моё'), (${coupleId}, 'dm', ${Y}, ${Y}, 'чужое')`;
    await sql`insert into notes (couple_id, author_user_id, text, approved_at) values (${coupleId}, ${X}, 'заметка', now())`;
    const h = env();
    await handleUpdate(dm(X, "/forget"), h.env);
    const ask = h.sent.at(-1);
    expect(ask.params.text).toContain("ru:data.forget_confirm");
    expect(ask.params.text).toContain("ru:menu.irreversible");
    expect(buttons(ask)).toEqual(["mn:do:forget", "mn:cancel"]);

    await handleUpdate(tap(X, "mn:do:forget"), h.env);
    expect(await sql`select text from messages where scope = 'dm'`).toEqual([{ text: "чужое" }]);
    expect(await sql`select id from notes`).toHaveLength(0);
  });

  it("/forget_group: история группы удалена, флаг остаётся (DR20), группа уведомлена", async () => {
    await sql`insert into messages (couple_id, scope, author_user_id, text) values (${coupleId}, 'group', ${X}, 'общее')`;
    await sql`insert into abuse_flags (couple_id, source) values (${coupleId}, 'group')`;
    const h = env();
    await handleUpdate(tap(Y, "mn:do:forget_group"), h.env);
    expect(await sql`select id from messages where scope = 'group'`).toHaveLength(0);
    expect(await sql`select id from abuse_flags where cleared_at is null`).toHaveLength(1);
    expect(h.sent.some((m) => m.chatId === CHAT && m.params.text.includes("data.forget_group_notice"))).toBe(true);
  });

  it("«Отмена» ничего не делает", async () => {
    const h = env();
    await handleUpdate(tap(X, "mn:cancel"), h.env);
    expect(h.sent.at(-1).params.text).toBe("ru:data.cancelled");
  });
});

describe("согласие и пауза", () => {
  it("отзыв: пара revoked, группа уведомлена; отозвавший получает ответ только на /consent и /forget", async () => {
    const h = env();
    await handleUpdate(tap(X, "mn:do:revoke"), h.env);
    const [c] = await sql`select state from couples where id = ${coupleId}`;
    expect(c.state).toBe("revoked");
    expect(h.sent.some((m) => m.chatId === CHAT && m.params.text.includes("state.revoked"))).toBe(true);

    await handleUpdate(dm(X, "привет"), h.env);
    expect(h.sent.at(-1).params.text).toBe("ru:data.only_consent_forget");
    expect(h.env.generate).not.toHaveBeenCalled();

    await handleUpdate(dm(X, "/consent"), h.env);
    const [after] = await sql`select state from couples where id = ${coupleId}`;
    expect(after.state).toBe("active");
  });

  it("пауза после собственного сигнала — сначала «партнёр поймёт, что это сделал ты»", async () => {
    await sql`insert into abuse_flags (couple_id, source) values (${coupleId}, ${`dm:${X}`})`;
    const h = env();
    await handleUpdate(dm(X, "/pause"), h.env);
    expect(h.sent.at(-1).params.text).toBe("ru:data.anonymity_warning");
    expect(buttons(h.sent.at(-1))).toEqual(["mn:anon:pause", "mn:cancel"]);
    const [before] = await sql`select state from couples where id = ${coupleId}`;
    expect(before.state).toBe("active");

    await handleUpdate(tap(X, "mn:anon:pause"), h.env);
    const [after] = await sql`select state, paused_by from couples where id = ${coupleId}`;
    expect(after.state).toBe("paused");
    expect(Number(after.paused_by)).toBe(X);
  });

  it("/flag_clear снимает только свою отметку dm:X", async () => {
    await sql`insert into abuse_flags (couple_id, source) values (${coupleId}, ${`dm:${X}`}), (${coupleId}, ${`dm:${Y}`}), (${coupleId}, 'group')`;
    const h = env();
    await handleUpdate(dm(X, "/flag_clear"), h.env);
    const active = await sql`select source from abuse_flags where cleared_at is null order by source`;
    expect(active.map((r) => r.source)).toEqual([`dm:${Y}`, "group"]);
  });

  it("/resume чужим — отказ (DR19)", async () => {
    await sql`update couples set state = 'paused', paused_by = ${X} where id = ${coupleId}`;
    const h = env();
    await handleUpdate(dm(Y, "/resume"), h.env);
    expect(h.sent.at(-1).params.text).toBe("es:state.resume_not_pauser");
  });
});
