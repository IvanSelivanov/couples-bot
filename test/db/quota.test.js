// quota_take: tier threshold and atomicity (R20, R31).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { quotaTake } from "../../lib/db.js";
import { connect, truncateAll, useLocalSupabase } from "./helpers.js";

const sql = connect();
beforeAll(useLocalSupabase);
afterAll(() => sql.end());
beforeEach(() => truncateAll(sql));

describe("quota_take", () => {
  it("пускает до порога уровня и не дальше", async () => {
    // limit 10, 70% tier → exactly 7 requests
    const results = [];
    for (let i = 0; i < 9; i++) results.push(await quotaTake(10, 70));
    expect(results.filter((r) => r.allowed)).toHaveLength(7);
    expect(results.at(-1)).toEqual({ allowed: false, used: 7 });
  });

  it("уровень 100% пускает после исчерпания 90%", async () => {
    for (let i = 0; i < 9; i++) await quotaTake(10, 90);
    expect((await quotaTake(10, 90)).allowed).toBe(false);
    expect((await quotaTake(10, 100)).allowed).toBe(true);
    expect((await quotaTake(10, 100)).allowed).toBe(false);
  });

  it("параллельные вызовы не проскакивают порог", async () => {
    const results = await Promise.all(Array.from({ length: 30 }, () => quotaTake(20, 50)));
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
    const [row] = await sql`select requests from quota`;
    expect(row.requests).toBe(10);
  });

  it("день считается по тихоокеанскому времени", async () => {
    await quotaTake(10, 100);
    const [row] = await sql`
      select day = (now() at time zone 'America/Los_Angeles')::date as pacific from quota
    `;
    expect(row.pacific).toBe(true);
  });
});
