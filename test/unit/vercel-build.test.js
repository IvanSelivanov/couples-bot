// The Vercel build step: readable settings check, production-only migrations and
// Telegram setup, previews untouched.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { build, checkSettings, migrationDbUrl } from "../../scripts/vercel-build.js";

const GOOD = {
  BOT_TOKEN: "123456789:test-only-not-a-real-token-xyz", // fake: matches the shape check, not a real token
  GEMINI_API_KEY: "key",
  ADMIN_NAME: "Ivan",
  DM_ENCRYPTION_KEY: "a long enough passphrase",
  SUPABASE_URL: "https://ref.supabase.co",
  SUPABASE_SECRET_KEY: "sb_secret_x",
};

let deps;
beforeEach(() => {
  deps = { migrateFn: vi.fn(), configureFn: vi.fn(), prepareFn: vi.fn() };
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("checkSettings", () => {
  it("all set, with the Supabase integration's variable names: no problems", () => {
    expect(checkSettings(GOOD)).toEqual([]);
  });

  it("a manual setup's names work too", () => {
    const { SUPABASE_SECRET_KEY, ...rest } = GOOD;
    expect(checkSettings({ ...rest, SUPABASE_SERVICE_KEY: "eyJ..." })).toEqual([]);
  });

  it("every problem names the setting and what to put there", () => {
    const problems = checkSettings({ BOT_TOKEN: "not a token", DM_ENCRYPTION_KEY: "short" });
    expect(problems.join("\n")).toMatch(/BOT_TOKEN doesn't look like a bot token/);
    expect(problems.join("\n")).toMatch(/GEMINI_API_KEY is empty/);
    expect(problems.join("\n")).toMatch(/ADMIN_NAME is empty/);
    expect(problems.join("\n")).toMatch(/DM_ENCRYPTION_KEY is too short/);
    expect(problems.join("\n")).toMatch(/connect Supabase/);
  });
});

describe("migrationDbUrl", () => {
  it("SUPABASE_DB_URL wins over the integration's POSTGRES_URL_NON_POOLING", () => {
    expect(migrationDbUrl({ POSTGRES_URL_NON_POOLING: "b" })).toBe("b");
    expect(migrationDbUrl({ SUPABASE_DB_URL: "a", POSTGRES_URL_NON_POOLING: "b" })).toBe("a");
    expect(migrationDbUrl({})).toBeNull();
  });
});

describe("build", () => {
  it("broken settings: fails with the list and where to fix it, touches nothing", async () => {
    await expect(build({ VERCEL_ENV: "production" }, deps)).rejects.toThrow(/Settings → Environment Variables[\s\S]*BOT_TOKEN is empty/);
    expect(deps.migrateFn).not.toHaveBeenCalled();
    expect(deps.configureFn).not.toHaveBeenCalled();
  });

  it("preview: no migrations and no webhook, so the live bot stays on production", async () => {
    expect(await build({ ...GOOD, VERCEL_ENV: "preview", POSTGRES_URL_NON_POOLING: "db" }, deps)).toEqual({ migrated: false, telegram: false });
    expect(deps.migrateFn).not.toHaveBeenCalled();
    expect(deps.configureFn).not.toHaveBeenCalled();
    expect(deps.prepareFn).toHaveBeenCalled();
  });

  it("production: migrations first, then Telegram at the production URL", async () => {
    const order = [];
    deps.migrateFn.mockImplementation(() => order.push("migrate"));
    deps.configureFn.mockImplementation(async () => order.push("telegram"));
    const env = { ...GOOD, VERCEL_ENV: "production", POSTGRES_URL_NON_POOLING: "postgres://db", VERCEL_PROJECT_PRODUCTION_URL: "couples-bot.vercel.app" };
    expect(await build(env, deps)).toEqual({ migrated: true, telegram: true });
    expect(deps.migrateFn).toHaveBeenCalledWith("postgres://db");
    expect(deps.configureFn).toHaveBeenCalledWith("https://couples-bot.vercel.app");
    expect(order).toEqual(["migrate", "telegram"]);
  });

  it("production without a database URL: warns and still sets up Telegram", async () => {
    const env = { ...GOOD, VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "x.vercel.app" };
    expect(await build(env, deps)).toEqual({ migrated: false, telegram: true });
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/skipping migrations/));
  });
});

it("preview with missing settings: a warning, not a failed build", async () => {
  expect(await build({ VERCEL_ENV: "preview" }, deps)).toEqual({ migrated: false, telegram: false });
  expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/BOT_TOKEN is empty/));
});
