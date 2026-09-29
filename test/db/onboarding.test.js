// T18: онбординг сквозь живую базу (DR7, DR8, R17). Telegram подменён.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleUpdate } from "../../lib/handle.js";
import { signInvite } from "../../lib/onboarding.js";
import { connect, truncateAll, useLocalSupabase } from "./helpers.js";

const sql = connect();
beforeAll(() => {
  useLocalSupabase();
  process.env.WEBHOOK_SECRET = "test-secret";
});
afterAll(() => sql.end());
beforeEach(() => truncateAll(sql));

const CHAT = -777;
const X = 31;
const Y = 42;
let updateId = 5000;
let messageId = 1;

function env({ groupOk = true } = {}) {
  const sent = [];
  const api = vi.fn(async (method) => (method === "getChatMember" ? { status: "member" } : true));
  return {
    sent,
    api,
    env: {
      text: async (lang, key) => `${lang}:${key}`,
      deliver: vi.fn(async (m) => {
        sent.push(m);
        return { status: "sent", tgMessageId: 9000 + sent.length };
      }),
      api,
      checkGroup: async () => (groupOk ? { ok: true } : { ok: false, reason: "not_admin" }),
      refreshHelpLines: vi.fn().mockResolvedValue([]),
      defer: () => {},
      botUsername: "couples_test_bot",
    },
  };
}

const groupStart = (from) => ({
  update_id: updateId++,
  message: { message_id: messageId++, chat: { id: CHAT, type: "supergroup" }, from: { id: from, first_name: "Иван", language_code: "ru" }, text: "/start" },
});
const dm = (from, text, extra = {}) => ({
  update_id: updateId++,
  message: { message_id: messageId++, chat: { id: from, type: "private" }, from: { id: from, first_name: extra.name ?? "María", language_code: extra.lang ?? "es" }, text },
});
const tap = (from, data) => ({
  update_id: updateId++,
  callback_query: { id: `cb${updateId}`, from: { id: from }, data, message: { message_id: 1, chat: { id: from, type: "private" } } },
});

async function coupleId() {
  const [c] = await sql`select id from couples where group_chat_id = ${CHAT}`;
  return c.id;
}

describe("регистрация группы", () => {
  it("бот не админ — просьба о правах, пара не создаётся", async () => {
    const h = env({ groupOk: false });
    h.env.text = async (lang, key, params) => `${lang}:${key}${params?.bot ? `:@${params.bot}` : ""}`;
    expect(await handleUpdate(groupStart(X), h.env)).toBe("not_admin");
    // Просьба называет бота: пользователю надо найти его в списке при добавлении админа.
    expect(h.sent[0].params.text).toBe("ru:onboarding.admin_request:@couples_test_bot");
    expect(await sql`select id from couples`).toHaveLength(0);
  });

  it("регистрация: пара onboarding, приветствие со ссылкой, закреплённый статус", async () => {
    const h = env();
    expect(await handleUpdate(groupStart(X), h.env)).toBe("registered");
    const id = await coupleId();
    const intro = h.sent.find((m) => m.key.endsWith(":intro"));
    expect(intro.params.reply_markup.inline_keyboard[0][0].url).toBe(`https://t.me/couples_test_bot?start=${signInvite(id)}`);
    const [c] = await sql`select state, status_message_id from couples where id = ${id}`;
    expect(c.state).toBe("onboarding");
    expect(Number(c.status_message_id)).toBeGreaterThan(0);
    expect(h.api).toHaveBeenCalledWith("pinChatMessage", expect.objectContaining({ chat_id: CHAT }));
  });
});

describe("личка", () => {
  it("посторонний /start — закрытый бот", async () => {
    const h = env();
    expect(await handleUpdate(dm(99, "/start"), h.env)).toBe("stranger");
    expect(h.sent[0].params.text).toBe("es:state.stranger_start");
  });

  it("подделанная ссылка — закрытый бот", async () => {
    const h = env();
    await handleUpdate(groupStart(X), h.env);
    expect(await handleUpdate(dm(Y, `/start g${await coupleId()}_AAAAAAAAAAAAAAAA`), h.env)).toBe("stranger");
  });

  it("полный путь двоих: язык → страна → время → согласие → active и «Всё готово»", async () => {
    const h = env();
    await handleUpdate(groupStart(X), h.env);
    const id = await coupleId();
    const link = `/start ${signInvite(id)}`;

    // María вступает по ссылке и проходит шаги.
    expect(await handleUpdate(dm(Y, link), h.env)).toBe("onboarding");
    await handleUpdate(tap(Y, "ob:lang:es"), h.env);
    await handleUpdate(tap(Y, "ob:country:ES"), h.env);
    await handleUpdate(dm(Y, "14:30"), h.env);
    await handleUpdate(tap(Y, "ob:consent:yes"), h.env);

    // Иван уже участник (вызвал /start в группе) — проходит шаги в личке.
    await handleUpdate(dm(X, link, { name: "Иван", lang: "ru" }), h.env);
    await handleUpdate(tap(X, "ob:lang:ru"), h.env);
    await handleUpdate(dm(X, "Россия", { lang: "ru" }), h.env);
    await handleUpdate(dm(X, "9:05", { lang: "ru" }), h.env);
    await handleUpdate(tap(X, "ob:consent:yes"), h.env);

    const [c] = await sql`select state from couples where id = ${id}`;
    expect(c.state).toBe("active");
    const members = await sql`select user_id, lang, country, tz is not null as has_tz, consented_at is not null as consented from members order by user_id`;
    expect(members.map((m) => [Number(m.user_id), m.lang, m.country, m.has_tz, m.consented])).toEqual([
      [X, "ru", "RU", true, true],
      [Y, "es", "ES", true, true],
    ]);
    expect(h.sent.some((m) => m.key === `ready:${id}`)).toBe(true);
    expect(h.env.refreshHelpLines).toHaveBeenCalledWith("ES");
  });

  it("«Не сейчас» — никаких следов в группе, повторный /start снова спрашивает согласие", async () => {
    const h = env();
    await handleUpdate(groupStart(X), h.env);
    const id = await coupleId();
    await handleUpdate(dm(Y, `/start ${signInvite(id)}`), h.env);
    await handleUpdate(tap(Y, "ob:lang:es"), h.env);
    await handleUpdate(tap(Y, "ob:country:ES"), h.env);
    await handleUpdate(dm(Y, "14:30"), h.env);
    const before = h.sent.filter((m) => m.scope === "group").length;
    await handleUpdate(tap(Y, "ob:consent:no"), h.env);
    expect(h.sent.at(-1).params.text).toBe("es:onboarding.declined");
    expect(h.sent.filter((m) => m.scope === "group").length).toBe(before);

    await handleUpdate(dm(Y, "/start"), h.env);
    expect(h.sent.at(-1).params.reply_markup.inline_keyboard.flat().map((b) => b.callback_data)).toEqual([
      "ob:consent:yes",
      "ob:consent:no",
    ]);
  });

  it("третий по ссылке не вступает", async () => {
    const h = env();
    await handleUpdate(groupStart(X), h.env);
    const link = `/start ${signInvite(await coupleId())}`;
    await handleUpdate(dm(Y, link), h.env);
    expect(await handleUpdate(dm(77, link), h.env)).toBe("full");
    expect(h.sent.at(-1).params.text).toBe("es:onboarding.couple_full");
  });

  it("неверное время — просьба повторить", async () => {
    const h = env();
    await handleUpdate(groupStart(X), h.env);
    await handleUpdate(dm(Y, `/start ${signInvite(await coupleId())}`), h.env);
    await handleUpdate(tap(Y, "ob:lang:es"), h.env);
    await handleUpdate(tap(Y, "ob:country:ES"), h.env);
    await handleUpdate(dm(Y, "полдень"), h.env);
    expect(h.sent.at(-1).params.text).toBe("es:onboarding.bad_time");
  });
});
