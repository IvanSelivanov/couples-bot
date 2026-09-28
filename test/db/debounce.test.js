// debounce_state на живой базе (R1, R11) и сквозной respond-каркас.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { debounceState } from "../../lib/db.js";
import { respond, runCheck } from "../../lib/session.js";
import { addPartnerMessage, connect, createCouple, truncateAll, useLocalSupabase } from "./helpers.js";

const sql = connect();
beforeAll(useLocalSupabase);
afterAll(() => sql.end());
beforeEach(() => truncateAll(sql));

describe("debounce_state", () => {
  it("пустое окно", async () => {
    const { windowId } = await createCouple(sql);
    expect(await debounceState(windowId)).toEqual({
      answeredUpTo: 0,
      latestId: null,
      firstUnansweredId: null,
      ended: false,
      checkActive: false,
      pendingTranscripts: 0,
      latestAt: null,
    });
  });

  it("последняя и первая неотвеченная реплики партнёров", async () => {
    const { coupleId, windowId } = await createCouple(sql);
    const m1 = await addPartnerMessage(sql, coupleId);
    const m2 = await addPartnerMessage(sql, coupleId);
    const m3 = await addPartnerMessage(sql, coupleId);
    await sql`update windows set answered_up_to = ${m1} where id = ${windowId}`;
    const state = await debounceState(windowId);
    expect(state.latestId).toBe(Number(m3));
    expect(state.firstUnansweredId).toBe(Number(m2));
  });

  it("реплики бота и личек не считаются", async () => {
    const { coupleId, windowId } = await createCouple(sql);
    const m1 = await addPartnerMessage(sql, coupleId);
    await sql`insert into messages (couple_id, scope, is_bot, text) values (${coupleId}, 'group', true, 'бот')`;
    await sql`insert into messages (couple_id, scope, owner_user_id, author_user_id, text) values (${coupleId}, 'dm', 1, 1, 'x')`;
    expect((await debounceState(windowId)).latestId).toBe(Number(m1));
  });

  it("нет окна — null", async () => {
    expect(await debounceState(999_999)).toBeNull();
  });
});

describe("runCheck + respond-каркас", () => {
  it("захватывает аренду и снимает её, маркер не двигает", async () => {
    const { coupleId, windowId } = await createCouple(sql);
    const m1 = await addPartnerMessage(sql, coupleId);
    const decision = await runCheck({ windowId, messageId: Number(m1), kind: "debounce" }, { respond });
    expect(decision).toBe("respond");
    const [w] = await sql`select answered_up_to, lease_id from windows where id = ${windowId}`;
    expect(Number(w.answered_up_to)).toBe(0);
    expect(w.lease_id).toBeNull();
  });
});
