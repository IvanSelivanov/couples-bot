// T3: аренда окна ответа на настоящем Postgres (R2, R11, R12).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { canPublish, claimReplyWindow, finishReply } from "../../lib/db.js";
import { addPartnerMessage, connect, createCouple, truncateAll, useLocalSupabase } from "./helpers.js";

const sql = connect();
beforeAll(useLocalSupabase);
afterAll(() => sql.end());
beforeEach(() => truncateAll(sql));

describe("claim_reply_window", () => {
  it("из двух одновременных захватов выигрывает ровно один", async () => {
    const { windowId } = await createCouple(sql);
    const results = await Promise.all(Array.from({ length: 8 }, () => claimReplyWindow(windowId, 0)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("живая чужая аренда не даёт захватить", async () => {
    const { windowId } = await createCouple(sql);
    expect(await claimReplyWindow(windowId, 0)).toBeTruthy();
    expect(await claimReplyWindow(windowId, 0)).toBeNull();
  });

  it("истёкшая аренда захватывается заново", async () => {
    const { windowId } = await createCouple(sql);
    await claimReplyWindow(windowId, 0);
    await sql`update windows set generating_until = now() - interval '1 second' where id = ${windowId}`;
    expect(await claimReplyWindow(windowId, 0)).toBeTruthy();
  });

  it("сдвинутый маркер не даёт захватить по старому значению", async () => {
    const { windowId } = await createCouple(sql);
    await sql`update windows set answered_up_to = 5 where id = ${windowId}`;
    expect(await claimReplyWindow(windowId, 0)).toBeNull();
    expect(await claimReplyWindow(windowId, 5)).toBeTruthy();
  });

  it("закрытое окно не захватывается", async () => {
    const { windowId } = await createCouple(sql);
    await sql`update windows set ended_at = now() where id = ${windowId}`;
    expect(await claimReplyWindow(windowId, 0)).toBeNull();
  });
});

describe("finish_reply", () => {
  it("сдвигает маркер и снимает аренду своей задачи", async () => {
    const { coupleId, windowId } = await createCouple(sql);
    const m1 = await addPartnerMessage(sql, coupleId);
    const lease = await claimReplyWindow(windowId, 0);
    expect(await finishReply(windowId, lease, m1)).toEqual({ ok: true, newerMessageId: null });
    const [w] = await sql`select answered_up_to, lease_id, generating_until from windows where id = ${windowId}`;
    expect(Number(w.answered_up_to)).toBe(Number(m1));
    expect(w.lease_id).toBeNull();
    expect(w.generating_until).toBeNull();
  });

  it("чужая аренда ничего не меняет", async () => {
    const { coupleId, windowId } = await createCouple(sql);
    const m1 = await addPartnerMessage(sql, coupleId);
    await claimReplyWindow(windowId, 0);
    const result = await finishReply(windowId, "00000000-0000-0000-0000-000000000000", m1);
    expect(result.ok).toBe(false);
    const [w] = await sql`select answered_up_to from windows where id = ${windowId}`;
    expect(Number(w.answered_up_to)).toBe(0);
  });

  // Контрпример из outside voice №2: сообщения в t=20 и t=25, генерация
  // начинается после t=45 (пауза от t=25), а в t=50 приходит новое.
  // Задача t=50 не может захватить окно (аренда занята), поэтому хвост
  // должен вернуть finish_reply, иначе t=50 останется без ответа.
  it("возвращает сообщение, пришедшее во время генерации (хвост R11)", async () => {
    const { coupleId, windowId } = await createCouple(sql);
    await addPartnerMessage(sql, coupleId, { author: 1 });
    const m25 = await addPartnerMessage(sql, coupleId, { author: 2 });
    const lease = await claimReplyWindow(windowId, 0);

    const m50 = await addPartnerMessage(sql, coupleId, { author: 1 });
    expect(await claimReplyWindow(windowId, 0)).toBeNull();

    const result = await finishReply(windowId, lease, m25);
    expect(result).toEqual({ ok: true, newerMessageId: expect.anything() });
    expect(Number(result.newerMessageId)).toBe(Number(m50));
    expect(await claimReplyWindow(windowId, m25)).toBeTruthy();
  });

  it("сообщения бота и личек хвостом не считаются", async () => {
    const { coupleId, windowId } = await createCouple(sql);
    const m1 = await addPartnerMessage(sql, coupleId);
    const lease = await claimReplyWindow(windowId, 0);
    await sql`insert into messages (couple_id, scope, is_bot, text) values (${coupleId}, 'group', true, 'ответ')`;
    await sql`insert into messages (couple_id, scope, owner_user_id, author_user_id, text) values (${coupleId}, 'dm', 1, 1, 'x')`;
    expect((await finishReply(windowId, lease, m1)).newerMessageId).toBeNull();
  });
});

describe("can_publish (R12)", () => {
  it("true для своей живой аренды активной пары", async () => {
    const { windowId, stateVersion } = await createCouple(sql);
    const lease = await claimReplyWindow(windowId, 0);
    expect(await canPublish(windowId, lease, stateVersion)).toBe(true);
  });

  it("false после /pause во время генерации", async () => {
    const { coupleId, windowId, stateVersion } = await createCouple(sql);
    const lease = await claimReplyWindow(windowId, 0);
    await sql`update couples set state = 'paused', state_version = state_version + 1 where id = ${coupleId}`;
    expect(await canPublish(windowId, lease, stateVersion)).toBe(false);
  });

  it("false после истечения аренды", async () => {
    const { windowId, stateVersion } = await createCouple(sql);
    const lease = await claimReplyWindow(windowId, 0);
    await sql`update windows set generating_until = now() - interval '1 second' where id = ${windowId}`;
    expect(await canPublish(windowId, lease, stateVersion)).toBe(false);
  });

  it("false для чужой аренды", async () => {
    const { windowId, stateVersion } = await createCouple(sql);
    await claimReplyWindow(windowId, 0);
    expect(await canPublish(windowId, "00000000-0000-0000-0000-000000000000", stateVersion)).toBe(false);
  });
});
