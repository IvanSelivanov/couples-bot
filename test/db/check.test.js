// T10 на живой базе: запуск /check, частота, условные переходы.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyCheckEvent, startCheck } from "../../lib/session.js";
import { debounceState } from "../../lib/db.js";
import { connect, createCouple, truncateAll, useLocalSupabase } from "./helpers.js";

const sql = connect();
beforeAll(useLocalSupabase);
afterAll(() => sql.end());
beforeEach(() => truncateAll(sql));

const X = 1;
const Y = 2;
const start = (coupleId, speaker = X, listener = Y) => startCheck({ coupleId, speaker, listener, blockFrom: 1, blockTo: 2 });

describe("запуск", () => {
  it("первый /check стартует и просит пересказ у слушающего", async () => {
    const { coupleId } = await createCouple(sql);
    const r = await start(coupleId);
    expect(r.ok).toBe(true);
    expect(r.effects).toEqual([{ type: "ask_paraphrase", to: Y, blockFrom: 1, blockTo: 2, round: 1 }]);
  });

  it("второй одновременный — отказ «уже идёт»", async () => {
    const { coupleId } = await createCouple(sql);
    const [a, b] = await Promise.all([start(coupleId, X, Y), start(coupleId, Y, X)]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
  });

  it("повтор раньше 30 минут — отказ с честной причиной и минутами", async () => {
    const { coupleId } = await createCouple(sql);
    const first = await start(coupleId);
    await sql`update checks set ended_at = now(), started_at = now() - interval '10 minutes' where id = ${first.id}`;
    const r = await start(coupleId);
    expect(r.ok).toBe(false);
    expect(r.effects).toEqual([{ type: "say", key: "check.cooldown", minutes: 20 }]);
  });

  it("через 30 минут — можно, абьюз-флаг не мешает (D15)", async () => {
    const { coupleId } = await createCouple(sql);
    await sql`insert into abuse_flags (couple_id, source) values (${coupleId}, 'group')`;
    const first = await start(coupleId);
    await sql`update checks set ended_at = now(), started_at = now() - interval '31 minutes' where id = ${first.id}`;
    expect((await start(coupleId)).ok).toBe(true);
  });
});

describe("условные переходы", () => {
  it("двойное нажатие «Пропустить»: второе — «неактуально»", async () => {
    const { coupleId } = await createCouple(sql);
    await start(coupleId);
    const [a, b] = await Promise.all([
      applyCheckEvent(coupleId, { type: "skip", userId: Y }),
      applyCheckEvent(coupleId, { type: "skip", userId: Y }),
    ]);
    const all = [...a, ...b].map((e) => e.key ?? e.type);
    expect(all.filter((k) => k === "check.skipped")).toHaveLength(1);
    expect(all).toContain("button.stale");
  });

  it("полный путь: пересказ → вердикт → конец", async () => {
    const { coupleId } = await createCouple(sql);
    const { id } = await start(coupleId);
    await sql`update checks set prompt_message_id = 500 where id = ${id}`;
    await applyCheckEvent(coupleId, { type: "message", userId: Y, replyToMessageId: 500, messageId: 9 });
    const effects = await applyCheckEvent(coupleId, { type: "verdict", userId: X, understood: true });
    expect(effects.map((e) => e.key ?? e.type)).toContain("check.success");
    const [row] = await sql`select outcome, ended_at from checks where id = ${id}`;
    expect(row.outcome).toBe("understood");
    expect(row.ended_at).not.toBeNull();
  });

  it("кнопка после конца упражнения — «неактуально»", async () => {
    const { coupleId } = await createCouple(sql);
    await start(coupleId);
    await applyCheckEvent(coupleId, { type: "skip", userId: Y });
    expect(await applyCheckEvent(coupleId, { type: "verdict", userId: X, understood: true })).toEqual([
      { type: "popup", key: "button.stale" },
    ]);
  });

  it("активный /check виден дебаунсу", async () => {
    const { coupleId, windowId } = await createCouple(sql);
    await start(coupleId);
    expect((await debounceState(windowId)).checkActive).toBe(true);
  });
});
