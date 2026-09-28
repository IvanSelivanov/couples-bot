// Граница данных, статическая часть (дизайн-док, «Граница в коде»):
// сырые чтения contextReads импортируют только context.js и draft.js.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ALLOWED = new Set([join("lib", "context.js"), join("lib", "draft.js"), join("lib", "db.js")]);

function sources(dirs) {
  const files = [];
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith(".js")) files.push(p);
    }
  };
  dirs.forEach(walk);
  return files;
}

describe("граница данных", () => {
  it("contextReads упоминается только в context.js и draft.js", () => {
    const offenders = [...sources(["lib", "api", "spikes"]), "bot.js"].filter(
      (f) => !ALLOWED.has(f) && readFileSync(f, "utf8").includes("contextReads"),
    );
    expect(offenders).toEqual([]);
  });

  it("никто, кроме context.js, draft.js и db.js, не пишет запросы к messages/notes/summaries/drafts", () => {
    const raw = /["'`](?:messages|notes|summaries|drafts)\?/;
    const offenders = sources(["lib", "api"]).filter((f) => !ALLOWED.has(f) && raw.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
