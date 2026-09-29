// T5 on a live database: processed_updates and the Queues budget (R1, R3, R10, R27).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { markDone, markReceived, queueBudgetTake } from "../../lib/db.js";
import { connect, truncateAll, useLocalSupabase } from "./helpers.js";

const sql = connect();
beforeAll(useLocalSupabase);
afterAll(() => sql.end());
beforeEach(() => truncateAll(sql));

describe("markReceived / markDone", () => {
  it("новый апдейт — received, повтор до done — тоже received", async () => {
    expect(await markReceived(1)).toBe("received");
    expect(await markReceived(1)).toBe("received");
    const rows = await sql`select * from processed_updates`;
    expect(rows).toHaveLength(1);
  });

  it("после done повтор видит done", async () => {
    await markReceived(2);
    await markDone(2);
    expect(await markReceived(2)).toBe("done");
  });

  it("done стирает payload (R27)", async () => {
    await markReceived(3, "v1.aaa.bbb");
    const [before] = await sql`select payload from processed_updates where update_id = 3`;
    expect(before.payload).toBe("v1.aaa.bbb");
    await markDone(3);
    const [after] = await sql`select status, payload from processed_updates where update_id = 3`;
    expect(after).toEqual({ status: "done", payload: null });
  });

  it("повтор не затирает payload первой записи", async () => {
    await markReceived(4, "v1.first.x");
    await markReceived(4, "v1.second.y");
    const [row] = await sql`select payload from processed_updates where update_id = 4`;
    expect(row.payload).toBe("v1.first.x");
  });
});

describe("queue_budget_take (R1)", () => {
  it("пускает до 90% месячного бюджета", async () => {
    // limit 30 operations, 3 per message, 90% threshold → 27 operations = 9 messages
    const results = [];
    for (let i = 0; i < 12; i++) results.push(await queueBudgetTake(3, 30, 90));
    expect(results.filter(Boolean)).toHaveLength(9);
  });

  it("параллельные вызовы не проскакивают порог", async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => queueBudgetTake(3, 30, 90)));
    expect(results.filter(Boolean)).toHaveLength(9);
  });
});
