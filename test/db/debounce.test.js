// debounce_state on a live database (R1, R11) and the end-to-end respond skeleton.
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

describe("runCheck + respond на живой базе", () => {
  it("сбой модели: фолбэк уходит через outbox один раз, маркер сдвигается, аренда снята", async () => {
    const { coupleId, windowId } = await createCouple(sql);
    await sql`insert into members (user_id, couple_id, lang, display_name) values (1, ${coupleId}, 'ru', 'Иван'), (2, ${coupleId}, 'es', 'María')`;
    const m1 = await addPartnerMessage(sql, coupleId);
    const sent = [];
    const deps = {
      generate: async () => ({ unavailable: "error", reason: "network" }),
      text: async (lang, key) => `${lang}:${key}`,
      deliver: async (message) => {
        sent.push(message.key);
        return { status: "sent" };
      },
    };
    const decision = await runCheck(
      { windowId, messageId: Number(m1), kind: "debounce" },
      { respond: (w, marker) => respond(w, marker, deps) },
    );
    expect(decision).toBe("respond");
    expect(sent).toEqual([`pause:${windowId}:${m1}:0`]);
    const [w] = await sql`select answered_up_to, lease_id from windows where id = ${windowId}`;
    expect(Number(w.answered_up_to)).toBe(Number(m1));
    expect(w.lease_id).toBeNull();
  });
});
