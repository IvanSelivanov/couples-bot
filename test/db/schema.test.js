// T2: ограничения схемы, на которые опирается логика бота.
import { afterAll, beforeEach, describe, expect, inject, it } from "vitest";
import { connect, createCouple, truncateAll } from "./helpers.js";

const sql = connect();
afterAll(() => sql.end());
beforeEach(() => truncateAll(sql));

describe("messages: повтор апдейта (R3)", () => {
  it("вторая вставка того же tg-сообщения игнорируется через on conflict do nothing", async () => {
    const { coupleId } = await createCouple(sql);
    const insert = () => sql`
      insert into messages (couple_id, scope, author_user_id, tg_chat_id, tg_message_id, text)
      values (${coupleId}, 'group', 1, -100, 42, 'привет')
      on conflict (couple_id, scope, tg_chat_id, tg_message_id) do nothing
      returning id
    `;
    expect(await insert()).toHaveLength(1);
    expect(await insert()).toHaveLength(0);
  });

  it("сообщение лички без владельца отклоняется", async () => {
    const { coupleId } = await createCouple(sql);
    await expect(sql`
      insert into messages (couple_id, scope, author_user_id, text) values (${coupleId}, 'dm', 1, 'x')
    `).rejects.toThrow(/check/);
  });
});

describe("processed_updates (R3, R10)", () => {
  it("повтор update_id не создаёт вторую строку", async () => {
    const first = await sql`insert into processed_updates (update_id) values (7) on conflict do nothing returning update_id`;
    const second = await sql`insert into processed_updates (update_id) values (7) on conflict do nothing returning update_id`;
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });
});

describe("windows: одно открытое окно на пару (R21)", () => {
  it("второе открытое окно той же пары отклоняется индексом", async () => {
    const { coupleId } = await createCouple(sql);
    await expect(sql`insert into windows (couple_id) values (${coupleId})`).rejects.toThrow(/windows_one_open_per_couple/);
  });

  it("после закрытия можно открыть новое", async () => {
    const { coupleId, windowId } = await createCouple(sql);
    await sql`update windows set ended_at = now() where id = ${windowId}`;
    const rows = await sql`insert into windows (couple_id) values (${coupleId}) returning id`;
    expect(rows).toHaveLength(1);
  });
});

describe("RLS", () => {
  it("anon-ключ не видит таблиц", async () => {
    const { coupleId } = await createCouple(sql);
    expect(coupleId).toBeDefined();
    const response = await fetch(`${inject("restUrl")}/couples?select=id`, {
      headers: { apikey: inject("anonKey"), Authorization: `Bearer ${inject("anonKey")}` },
    });
    // RLS без политик: запрос проходит, но строк не видно.
    expect(await response.json()).toEqual([]);
  });

  it("anon-ключ не может вызвать функции аренды", async () => {
    const response = await fetch(`${inject("restUrl")}/rpc/claim_reply_window`, {
      method: "POST",
      headers: {
        apikey: inject("anonKey"),
        Authorization: `Bearer ${inject("anonKey")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_window_id: 1, p_expected_marker: 0 }),
    });
    expect(response.ok).toBe(false);
  });
});
