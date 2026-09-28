import { afterAll, describe, expect, inject, it } from "vitest";
import { connect } from "./helpers.js";

const sql = connect();
afterAll(() => sql.end());

describe("локальный Supabase", () => {
  it("Postgres отвечает", async () => {
    const [row] = await sql`select 1 as ok`;
    expect(row.ok).toBe(1);
  });

  it("PostgREST отвечает с service key", async () => {
    const response = await fetch(`${inject("restUrl")}/`, {
      headers: { apikey: inject("serviceKey"), Authorization: `Bearer ${inject("serviceKey")}` },
    });
    expect(response.status).toBe(200);
  });
});
