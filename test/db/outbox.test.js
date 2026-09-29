// T7 on a live database: the outbox idempotency key and draft locking (R13).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as db from "../../lib/db.js";
import { OutcomeUnknown, deliver } from "../../lib/telegram.js";
import { connect, createCouple, truncateAll, useLocalSupabase } from "./helpers.js";

const sql = connect();
beforeAll(useLocalSupabase);
afterAll(() => sql.end());
beforeEach(() => truncateAll(sql));

const msg = (key) => ({ key, scope: "group", chatId: -100, method: "sendMessage", params: { text: "x" } });

describe("outbound", () => {
  it("параллельные доставки с одним ключом отправляют ровно раз", async () => {
    let sends = 0;
    const sendFn = async () => {
      sends++;
      await new Promise((r) => setTimeout(r, 50));
      return { message_id: 1 };
    };
    const results = await Promise.all(Array.from({ length: 6 }, () => deliver(msg("pause:1:9:0"), { store: db, sendFn })));
    expect(sends).toBe(1);
    expect(results.filter((r) => r.status === "sent")).toHaveLength(1);
  });

  it("после sent повтор видит already_sent и tg_message_id", async () => {
    await deliver(msg("k1"), { store: db, sendFn: async () => ({ message_id: 42 }) });
    expect(await deliver(msg("k1"), { store: db, sendFn: async () => ({ message_id: 43 }) })).toEqual({
      status: "already_sent",
      tgMessageId: 42,
    });
  });

  it("unknown держит ключ: повтор не шлёт", async () => {
    await deliver(msg("k2"), {
      store: db,
      sendFn: async () => {
        throw new OutcomeUnknown("timeout");
      },
    });
    let sent = false;
    const second = await deliver(msg("k2"), {
      store: db,
      sendFn: async () => {
        sent = true;
      },
    });
    expect(second.status).toBe("already_unknown");
    expect(sent).toBe(false);
  });

  it("точный отказ освобождает ключ: следующая попытка шлёт", async () => {
    await deliver(msg("k3"), {
      store: db,
      sendFn: async () => {
        throw new Error("403");
      },
    });
    const second = await deliver(msg("k3"), { store: db, sendFn: async () => ({ message_id: 9 }) });
    expect(second.status).toBe("sent");
  });

  it("текст сообщения в outbox не хранится (R27)", async () => {
    await deliver(msg("k4"), { store: db, sendFn: async () => ({ message_id: 9 }) });
    const [row] = await sql`select payload from outbound where idempotency_key = 'k4'`;
    expect(row.payload).toBeNull();
  });
});

describe("draftLockForSending", () => {
  async function draft(userId = 10) {
    const { coupleId } = await createCouple(sql);
    const [row] = await sql`insert into drafts (couple_id, user_id, original) values (${coupleId}, ${userId}, 'x') returning id`;
    return row.id;
  }

  it("из двух одновременных нажатий проходит одно", async () => {
    const id = await draft();
    const results = await Promise.all([db.draftLockForSending(id, 10), db.draftLockForSending(id, 10)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("чужой черновик не блокируется", async () => {
    const id = await draft(10);
    expect(await db.draftLockForSending(id, 11)).toBe(false);
  });

  it("удалённый после отправки черновик не блокируется повторно", async () => {
    const id = await draft();
    await db.draftLockForSending(id, 10);
    await db.draftDelete(id);
    expect(await db.draftLockForSending(id, 10)).toBe(false);
  });
});
