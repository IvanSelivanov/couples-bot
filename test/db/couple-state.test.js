// T8: the couple state machine on a live database (R6, R12, R25, DR19).
// Every transition × (window open / /check active).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { canPublish, claimReplyWindow, coupleTransition } from "../../lib/db.js";
import { connect, truncateAll, useLocalSupabase } from "./helpers.js";

const sql = connect();
beforeAll(useLocalSupabase);
afterAll(() => sql.end());
beforeEach(() => truncateAll(sql));

const X = 101;
const Y = 202;

async function couple({ state = "active", pausedBy = null } = {}) {
  const [c] = await sql`
    insert into couples (group_chat_id, state, paused_by)
    values (${-Math.floor(Math.random() * 1e12)}, ${state}, ${pausedBy})
    returning id
  `;
  await sql`insert into members (user_id, couple_id, consented_at) values (${X}, ${c.id}, now()), (${Y}, ${c.id}, now())`;
  return c.id;
}
async function openWindow(coupleId) {
  const [w] = await sql`insert into windows (couple_id) values (${coupleId}) returning id`;
  return w.id;
}
async function activeCheck(coupleId) {
  await sql`
    insert into checks (couple_id, speaker_user_id, listener_user_id, block_from, block_to, state)
    values (${coupleId}, ${X}, ${Y}, 1, 2, 'awaiting_paraphrase')
  `;
}
async function snapshot(coupleId) {
  const [c] = await sql`select state, state_version, paused_by from couples where id = ${coupleId}`;
  const [{ open }] = await sql`select count(*)::int as open from windows where couple_id = ${coupleId} and ended_at is null`;
  const [{ checks }] = await sql`select count(*)::int as checks from checks where couple_id = ${coupleId} and ended_at is null`;
  return { state: c.state, version: c.state_version, pausedBy: c.paused_by === null ? null : Number(c.paused_by), open, checks };
}

describe("выход из active закрывает окно и /check", () => {
  it.each([
    ["pause", X, "paused"],
    ["revoke", Y, "revoked"],
    ["suspend", null, "suspended"],
  ])("%s → %s", async (event, actor, to) => {
    const id = await couple();
    await openWindow(id);
    await activeCheck(id);
    const r = await coupleTransition(id, event, actor);
    expect(r).toMatchObject({ ok: true, from: "active", to, changed: true });
    expect(await snapshot(id)).toMatchObject({ state: to, version: 1, open: 0, checks: 0 });
  });

  it("crisis в группе: остаётся active, но окно и /check остановлены", async () => {
    const id = await couple();
    await openWindow(id);
    await activeCheck(id);
    expect(await coupleTransition(id, "crisis")).toMatchObject({ ok: true, to: "active" });
    expect(await snapshot(id)).toMatchObject({ state: "active", version: 1, open: 0, checks: 0 });
  });

  it("идущая генерация не публикуется после /pause (R12)", async () => {
    const id = await couple();
    const w = await openWindow(id);
    const lease = await claimReplyWindow(w, 0);
    await coupleTransition(id, "pause", X);
    expect(await canPublish(w, lease, 0)).toBe(false);
  });
});

describe("пауза (DR19)", () => {
  it("pause запоминает, кто поставил", async () => {
    const id = await couple();
    await coupleTransition(id, "pause", X);
    expect((await snapshot(id)).pausedBy).toBe(X);
  });

  it("второй партнёр не снимает паузу, версия не меняется", async () => {
    const id = await couple();
    await coupleTransition(id, "pause", X);
    expect(await coupleTransition(id, "resume", Y)).toEqual({ ok: false, reason: "not_pauser", state: "paused" });
    expect(await snapshot(id)).toMatchObject({ state: "paused", version: 1 });
  });

  it("поставивший снимает паузу", async () => {
    const id = await couple();
    await coupleTransition(id, "pause", X);
    expect(await coupleTransition(id, "resume", X)).toMatchObject({ ok: true, to: "active" });
    expect(await snapshot(id)).toMatchObject({ state: "active", pausedBy: null, version: 2 });
  });

  it("повторная пауза — отказ", async () => {
    const id = await couple();
    await coupleTransition(id, "pause", X);
    expect(await coupleTransition(id, "pause", Y)).toMatchObject({ ok: false, reason: "not_active" });
  });
});

describe("отзыв согласия (R25)", () => {
  it("Y: /revoke + /consent при паузе X оставляет paused", async () => {
    const id = await couple();
    await coupleTransition(id, "pause", X);
    await coupleTransition(id, "revoke", Y);
    expect(await coupleTransition(id, "consent", Y)).toMatchObject({ ok: true, to: "paused" });
    expect(await snapshot(id)).toMatchObject({ state: "paused", pausedBy: X });
    expect(await coupleTransition(id, "resume", X)).toMatchObject({ ok: true, to: "active" });
  });

  it("без паузы /consent возвращает в active", async () => {
    const id = await couple();
    await coupleTransition(id, "revoke", Y);
    expect(await coupleTransition(id, "consent", Y)).toMatchObject({ ok: true, to: "active" });
  });

  it("пока второй не вернул согласие, пара остаётся revoked", async () => {
    const id = await couple();
    await coupleTransition(id, "revoke", X);
    await coupleTransition(id, "revoke", Y);
    expect(await coupleTransition(id, "consent", X)).toMatchObject({ ok: true, to: "revoked", changed: false });
    expect(await coupleTransition(id, "consent", Y)).toMatchObject({ ok: true, to: "active" });
  });
});

describe("приостановка из-за состава группы", () => {
  it("restore возвращает в active", async () => {
    const id = await couple();
    await coupleTransition(id, "suspend");
    expect(await coupleTransition(id, "restore")).toMatchObject({ ok: true, to: "active" });
  });

  it("пауза переживает приостановку", async () => {
    const id = await couple();
    await coupleTransition(id, "pause", X);
    await coupleTransition(id, "suspend");
    expect(await coupleTransition(id, "restore")).toMatchObject({ ok: true, to: "paused" });
  });
});

describe("онбординг и защита", () => {
  it("activate только из onboarding", async () => {
    const id = await couple({ state: "onboarding" });
    expect(await coupleTransition(id, "activate")).toMatchObject({ ok: true, to: "active" });
    expect(await coupleTransition(id, "activate")).toMatchObject({ ok: false, reason: "not_onboarding" });
  });

  it("из onboarding нельзя в pause", async () => {
    const id = await couple({ state: "onboarding" });
    expect(await coupleTransition(id, "pause", X)).toMatchObject({ ok: false, reason: "not_active" });
  });

  it("параллельные pause от обоих: проходит ровно одна", async () => {
    const id = await couple();
    const results = await Promise.all([coupleTransition(id, "pause", X), coupleTransition(id, "pause", Y)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect((await snapshot(id)).version).toBe(1);
  });

  it("неизвестная пара", async () => {
    expect(await coupleTransition(999_999, "pause", X)).toMatchObject({ ok: false, reason: "no_couple" });
  });
});
