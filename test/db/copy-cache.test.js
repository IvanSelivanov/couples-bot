// T15 на живой базе: кеш переводов и пометка stale (R23, TD1).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { copyCacheGet, copyCachePut } from "../../lib/db.js";
import { connect, truncateAll, useLocalSupabase } from "./helpers.js";

const sql = connect();
beforeAll(useLocalSupabase);
afterAll(() => sql.end());
beforeEach(() => truncateAll(sql));

describe("copy_cache", () => {
  it("запись и чтение", async () => {
    await copyCachePut({ lang: "es", key: "k", text: "hola", sourceHash: "h1", wasReviewed: false });
    expect(await copyCacheGet("es", "k")).toEqual({ text: "hola", source_hash: "h1", reviewed: false, stale: false });
  });

  it("повторная запись заменяет перевод и хеш", async () => {
    await copyCachePut({ lang: "es", key: "k", text: "hola", sourceHash: "h1", wasReviewed: false });
    await copyCachePut({ lang: "es", key: "k", text: "buenas", sourceHash: "h2", wasReviewed: false });
    expect(await copyCacheGet("es", "k")).toMatchObject({ text: "buenas", source_hash: "h2" });
  });

  it("вычитанный ключ после смены исходника — stale", async () => {
    await sql`insert into copy_cache (lang, key, text, source_hash, reviewed) values ('es', 'k', 'vieja', 'h1', true)`;
    await copyCachePut({ lang: "es", key: "k", text: "nueva", sourceHash: "h2", wasReviewed: true });
    expect(await copyCacheGet("es", "k")).toEqual({ text: "nueva", source_hash: "h2", reviewed: false, stale: true });
  });

  it("нет строки — null", async () => {
    expect(await copyCacheGet("de", "k")).toBeNull();
  });
});
