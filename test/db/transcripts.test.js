// T30 на живой базе: гейт расшифровки в аренде, CAS статуса и late (R22, R26).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { claimReplyWindow, debounceState, expireTranscripts, ingestGroupMessage, setTranscript } from "../../lib/db.js";
import { connect, truncateAll, useLocalSupabase } from "./helpers.js";

const sql = connect();
beforeAll(useLocalSupabase);
afterAll(() => sql.end());
beforeEach(() => truncateAll(sql));

let tg = 1;
async function setup() {
  const [c] = await sql`insert into couples (group_chat_id, state) values (-1, 'active') returning id`;
  const text = await ingestGroupMessage({ coupleId: c.id, authorUserId: 1, tgChatId: -1, tgMessageId: tg++, text: "x" });
  const voice = await ingestGroupMessage({ coupleId: c.id, authorUserId: 2, tgChatId: -1, tgMessageId: tg++, kind: "voice" });
  return { coupleId: c.id, windowId: voice.windowId, voiceId: voice.messageId, textId: text.messageId };
}

describe("гейт в claim_reply_window (R22)", () => {
  it("pending в блоке — аренда не выдаётся", async () => {
    const { windowId } = await setup();
    expect(await claimReplyWindow(windowId, 0)).toBeNull();
    expect((await debounceState(windowId)).pendingTranscripts).toBe(1);
  });

  it("после расшифровки — выдаётся", async () => {
    const { windowId, voiceId } = await setup();
    expect(await setTranscript(voiceId, "расшифровка")).toEqual({ applied: true, late: false });
    expect(await claimReplyWindow(windowId, 0)).toBeTruthy();
  });

  it("после failed по потолку — выдаётся", async () => {
    const { coupleId, windowId, voiceId } = await setup();
    await sql`update messages set created_at = now() - interval '121 seconds' where id = ${voiceId}`;
    expect(await expireTranscripts(coupleId, 120)).toBe(1);
    expect(await claimReplyWindow(windowId, 0)).toBeTruthy();
  });

  it("свежий pending потолок не трогает", async () => {
    const { coupleId } = await setup();
    expect(await expireTranscripts(coupleId, 120)).toBe(0);
  });
});

describe("set_transcript (R26)", () => {
  it("статус меняется один раз: повтор ничего не делает", async () => {
    const { voiceId } = await setup();
    await setTranscript(voiceId, "первый");
    expect(await setTranscript(voiceId, "второй")).toEqual({ applied: false, late: false });
    const [m] = await sql`select text from messages where id = ${voiceId}`;
    expect(m.text).toBe("первый");
  });

  it("поздний результат после failed: текст сохраняется с late, статус не меняется", async () => {
    const { coupleId, voiceId } = await setup();
    await sql`update messages set created_at = now() - interval '121 seconds' where id = ${voiceId}`;
    await expireTranscripts(coupleId, 120);
    expect(await setTranscript(voiceId, "поздний")).toEqual({ applied: false, late: true });
    const [m] = await sql`select text, transcript_status, transcript_late from messages where id = ${voiceId}`;
    expect(m).toEqual({ text: "поздний", transcript_status: "failed", transcript_late: true });
  });

  it("гонка: результат и истечение одновременно — ровно один исход", async () => {
    const { coupleId, voiceId } = await setup();
    await sql`update messages set created_at = now() - interval '121 seconds' where id = ${voiceId}`;
    const [transcript] = await Promise.all([setTranscript(voiceId, "текст"), expireTranscripts(coupleId, 120)]);
    const [m] = await sql`select transcript_status, transcript_late from messages where id = ${voiceId}`;
    if (transcript.applied) expect(m).toEqual({ transcript_status: "done", transcript_late: false });
    else expect(m).toEqual({ transcript_status: "failed", transcript_late: true });
  });
});
