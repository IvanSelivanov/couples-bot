// T25: Guest Mode сквозь живую базу (DR12; «Guest Mode» в дизайн-доке).
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

const X = 101;
const Y = 202;
const THIRD = 303;
let updateId = 30000;

beforeEach(async () => {
  await truncateAll(sql);
  const [c] = await sql`insert into couples (group_chat_id, state) values (-3131, 'active') returning id`;
  await sql`insert into members (user_id, couple_id, lang, display_name, onboarding_step, consented_at) values
    (${X}, ${c.id}, 'ru', 'Иван', 'done', now()), (${Y}, ${c.id}, 'es', 'María', 'done', now())`;
});

function env(generateResult = { ok: true, data: { safety: "none", lines: [{ lang: "ru", text: "Возможно, она устала." }, { lang: "es", text: "Quizás estaba cansada." }] } }) {
  const sent = [];
  return {
    sent,
    env: {
      text: async (lang, key) => `${lang}:${key}`,
      deliver: vi.fn(async (m) => {
        sent.push(m);
        return { status: "sent" };
      }),
      api: vi.fn().mockResolvedValue(true),
      generate: vi.fn().mockResolvedValue(generateResult),
      onSafety: vi.fn(),
      defer: () => {},
    },
  };
}

const guest = (from, chat, extra = {}) => ({
  update_id: updateId++,
  guest_message: {
    guest_query_id: `q${updateId}`,
    message_id: 10,
    from: { id: from },
    chat,
    text: "@bot что она имела в виду?",
    reply_to_message: { message_id: 9, from: { id: Y }, text: "Déjalo, no importa" },
    ...extra,
  },
});

describe("Guest Mode", () => {
  it("посторонний вызвавший — молчим, модель не зовём", async () => {
    const h = env();
    expect(await handleUpdate(guest(THIRD, { id: X, type: "private" }), h.env)).toBe("guest_stranger");
    expect(h.env.generate).not.toHaveBeenCalled();
    expect(h.sent).toHaveLength(0);
  });

  it("личка пары: оба сообщения в историю, ответ на двух языках через answerGuestQuery", async () => {
    const h = env();
    expect(await handleUpdate(guest(X, { id: Y, type: "private" }), h.env)).toBe("guest_confirmed");
    const stored = await sql`select author_user_id, text from messages where scope = 'guest' order by tg_message_id`;
    expect(stored.map((r) => r.text)).toEqual(["Déjalo, no importa", "@bot что она имела в виду?"]);
    const answer = h.sent[0];
    expect(answer.method).toBe("answerGuestQuery");
    expect(answer.params.result.input_message_content.message_text).toContain("Возможно, она устала.");
    expect(answer.params.result.input_message_content.message_text).toContain("Quizás estaba cansada.");
    expect(h.env.generate.mock.calls[0][0].purpose).toBe("guest");
  });

  it("чат с третьим: ничего не сохраняется, язык вызвавшего, без контекста пары", async () => {
    const h = env({ ok: true, data: { safety: "none", lines: [{ lang: "ru", text: "Она просит оставить это." }] } });
    expect(await handleUpdate(guest(X, { id: THIRD, type: "private" }), h.env)).toBe("guest_unconfirmed");
    expect(await sql`select id from messages`).toHaveLength(0);
    expect(h.env.generate.mock.calls[0][0].parts[0].text).toContain("unconfirmed chat");
    expect(h.sent[0].params.result.input_message_content.message_text).toBe("Она просит оставить это.");
  });

  it("сигнал в чате с третьим: без флага пары, набор только вызвавшему, в чат нейтральная строка", async () => {
    const h = env({ ok: true, data: { safety: "abuse", lines: [] } });
    await handleUpdate(guest(X, { id: THIRD, type: "private" }), h.env);
    expect(h.env.onSafety).toHaveBeenCalledWith(expect.objectContaining({ surface: "dm", fromUserId: X, noFlag: true }));
    expect(h.sent[0].params.result.input_message_content.message_text).toBe("ru:safety.group_line");
  });

  it("сигнал в личке пары — поверхность guest", async () => {
    const h = env({ blocked: "crisis" });
    await handleUpdate(guest(X, { id: Y, type: "private" }), h.env);
    expect(h.env.onSafety).toHaveBeenCalledWith(expect.objectContaining({ surface: "guest", signal: "crisis" }));
  });

  it("пара не active — «не могу ответить» без модели", async () => {
    await sql`update couples set state = 'revoked'`;
    const h = env();
    expect(await handleUpdate(guest(X, { id: Y, type: "private" }), h.env)).toBe("guest_inactive");
    expect(h.env.generate).not.toHaveBeenCalled();
  });
});

describe("запасной путь: пересылка в личку", () => {
  it("пересланное сообщение объясняется в личке с пометкой «видишь только ты»", async () => {
    const h = env({ ok: true, data: { safety: "none", reply: "Возможно, ей нужна пауза." } });
    const update = {
      update_id: updateId++,
      message: {
        message_id: 77,
        chat: { id: X, type: "private" },
        from: { id: X },
        text: "Déjalo, no importa",
        forward_origin: { type: "user", sender_user: { id: Y } },
      },
    };
    expect(await handleUpdate(update, h.env)).toBe("dm_reply");
    expect(h.env.generate.mock.calls[0][0].parts[0].text).toContain("[forwarded message] Déjalo");
    expect(h.sent.at(-1).params.text).toContain("ru:guest.only_you");
  });
});
