// The bot's @username: from BOT_USERNAME or from getMe, asked once per process.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const me = (username) => new Response(JSON.stringify({ ok: true, result: { id: 1, username } }), { status: 200 });

let fetchMock;
beforeEach(() => {
  vi.resetModules();
  process.env.BOT_TOKEN = "t";
  delete process.env.BOT_USERNAME;
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("botUsername", () => {
  it("BOT_USERNAME set: taken as is, without @, no network", async () => {
    process.env.BOT_USERNAME = "@couple_psych_bot";
    const { botUsername } = await import("../../lib/telegram.js");
    expect(await botUsername()).toBe("couple_psych_bot");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("not set: asked from getMe once, then cached", async () => {
    fetchMock.mockImplementation(async () => me("from_getme_bot"));
    const { botUsername } = await import("../../lib/telegram.js");
    expect(await Promise.all([botUsername(), botUsername()])).toEqual(["from_getme_bot", "from_getme_bot"]);
    expect(await botUsername()).toBe("from_getme_bot");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("getMe failed: the next call tries again instead of caching the failure", async () => {
    fetchMock
      .mockImplementationOnce(async () => new Response(JSON.stringify({ ok: false, description: "Unauthorized" }), { status: 401 }))
      .mockImplementation(async () => me("second_try_bot"));
    const { botUsername } = await import("../../lib/telegram.js");
    await expect(botUsername()).rejects.toThrow();
    expect(await botUsername()).toBe("second_try_bot");
  });
});
