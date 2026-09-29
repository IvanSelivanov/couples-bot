// T29: one window per couple and message intake in one transaction (R21).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ingestGroupMessage } from "../../lib/db.js";
import { connect, truncateAll, useLocalSupabase } from "./helpers.js";

const sql = connect();
beforeAll(useLocalSupabase);
afterAll(() => sql.end());
beforeEach(() => truncateAll(sql));

let tg = 1;
async function couple() {
  const [c] = await sql`insert into couples (group_chat_id, state) values (-1, 'active') returning id`;
  return c.id;
}
const say = (coupleId, author, extra = {}) =>
  ingestGroupMessage({ coupleId, authorUserId: author, tgChatId: -1, tgMessageId: tg++, text: "x", ...extra });

describe("ingest_group_message", () => {
  it("первая реплика открывает окно", async () => {
    const c = await couple();
    const r = await say(c, 1);
    expect(r).toMatchObject({ closedWindowId: null, duplicate: false });
    const [{ open }] = await sql`select count(*)::int as open from windows where couple_id = ${c} and ended_at is null`;
    expect(open).toBe(1);
  });

  it("две одновременные реплики после тишины — одно окно (R21)", async () => {
    const c = await couple();
    const results = await Promise.all([say(c, 1), say(c, 2), say(c, 1), say(c, 2)]);
    expect(new Set(results.map((r) => r.windowId)).size).toBe(1);
    const [{ total }] = await sql`select count(*)::int as total from windows where couple_id = ${c}`;
    expect(total).toBe(1);
  });

  it("после 30 минут тишины окно закрывается, открывается новое и сообщается старое", async () => {
    const c = await couple();
    const first = await say(c, 1);
    await sql`update windows set last_message_at = now() - interval '31 minutes' where id = ${first.windowId}`;
    const second = await say(c, 2);
    expect(second.windowId).not.toBe(first.windowId);
    expect(second.closedWindowId).toBe(first.windowId);
  });

  it("до 30 минут — то же окно", async () => {
    const c = await couple();
    const first = await say(c, 1);
    await sql`update windows set last_message_at = now() - interval '29 minutes' where id = ${first.windowId}`;
    expect((await say(c, 2)).windowId).toBe(first.windowId);
  });

  it("повтор того же апдейта — duplicate, одна строка", async () => {
    const c = await couple();
    const a = await ingestGroupMessage({ coupleId: c, authorUserId: 1, tgChatId: -1, tgMessageId: 999, text: "x" });
    const b = await ingestGroupMessage({ coupleId: c, authorUserId: 1, tgChatId: -1, tgMessageId: 999, text: "x" });
    expect(b).toMatchObject({ duplicate: true, messageId: a.messageId });
  });

  it("голосовое получает transcript_status = pending (R22)", async () => {
    const c = await couple();
    const r = await say(c, 1, { kind: "voice", text: null });
    const [m] = await sql`select transcript_status from messages where id = ${r.messageId}`;
    expect(m.transcript_status).toBe("pending");
  });
});
