// T11: бот-админ и состав группы (R17).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { affectsComposition, checkGroup, recheckComposition } from "../../lib/onboarding.js";

const BOT = 900;
const X = 1;
const Y = 2;

function fakeApi({ botStatus = "administrator", count = 3, statuses = { [X]: "creator", [Y]: "member" }, privacy = true } = {}) {
  return vi.fn(async (method, params) => {
    switch (method) {
      case "getMe":
        return { id: BOT, can_read_all_group_messages: privacy };
      case "getChatMember":
        return { status: params.user_id === BOT ? botStatus : (statuses[params.user_id] ?? "left") };
      case "getChatMemberCount":
        return count;
      default:
        throw new Error(`unexpected ${method}`);
    }
  });
}

beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => {}));

describe("checkGroup", () => {
  it("бот-админ, пара и бот — готово", async () => {
    expect(await checkGroup(-1, [X, Y], { api: fakeApi() })).toEqual({ ok: true });
  });

  it("бот не админ — инструкция, а не регистрация", async () => {
    expect(await checkGroup(-1, [X, Y], { api: fakeApi({ botStatus: "member" }) })).toEqual({ ok: false, reason: "not_admin" });
  });

  it("третий человек в группе", async () => {
    expect(await checkGroup(-1, [X, Y], { api: fakeApi({ count: 4 }) })).toEqual({ ok: false, reason: "wrong_count", count: 4 });
  });

  it("участник пары вышел, а вместо него другой", async () => {
    const api = fakeApi({ statuses: { [X]: "creator", [Y]: "left" } });
    expect(await checkGroup(-1, [X, Y], { api })).toEqual({ ok: false, reason: "member_missing" });
  });

  it("privacy mode не блокирует, только диагностика в логе (R17 вместо D5)", async () => {
    expect(await checkGroup(-1, [X, Y], { api: fakeApi({ privacy: false }) })).toEqual({ ok: true });
    expect(console.warn).toHaveBeenCalled();
  });

  it("на онбординге, пока известен только один участник", async () => {
    expect(await checkGroup(-1, [X], { api: fakeApi() })).toEqual({ ok: true });
  });
});

describe("recheckComposition", () => {
  const couple = (state) => ({ id: 7, groupChatId: -1, state, memberIds: [X, Y] });

  it("потеря админки при active → suspended с объяснением", async () => {
    const transition = vi.fn().mockResolvedValue({ ok: true, to: "suspended" });
    const effects = await recheckComposition(couple("active"), { api: fakeApi({ botStatus: "member" }), transition });
    expect(transition).toHaveBeenCalledWith(7, "suspend");
    expect(effects).toEqual([{ type: "say", key: "state.suspended_not_admin" }]);
  });

  it("третий в группе на паузе → тоже suspended", async () => {
    const transition = vi.fn().mockResolvedValue({ ok: true, to: "suspended" });
    const effects = await recheckComposition(couple("paused"), { api: fakeApi({ count: 4 }), transition });
    expect(effects).toEqual([{ type: "say", key: "state.suspended_third_member" }]);
  });

  it("состав восстановлен → restore", async () => {
    const transition = vi.fn().mockResolvedValue({ ok: true, to: "active" });
    const effects = await recheckComposition(couple("suspended"), { api: fakeApi(), transition });
    expect(transition).toHaveBeenCalledWith(7, "restore");
    expect(effects).toEqual([{ type: "say", key: "state.restored", to: "active" }]);
  });

  it("всё в порядке и пара active — ничего", async () => {
    const transition = vi.fn();
    expect(await recheckComposition(couple("active"), { api: fakeApi(), transition })).toEqual([]);
    expect(transition).not.toHaveBeenCalled();
  });

  it("revoked не трогаем: отзыв согласия важнее состава", async () => {
    const transition = vi.fn();
    expect(await recheckComposition(couple("revoked"), { api: fakeApi({ count: 4 }), transition })).toEqual([]);
  });
});

describe("affectsComposition", () => {
  it.each([
    [{ message: { new_chat_members: [{ id: 5 }] } }, true],
    [{ message: { left_chat_member: { id: 5 } } }, true],
    [{ my_chat_member: { new_chat_member: { status: "member" } } }, true],
    [{ message: { text: "привет" } }, false],
  ])("%j → %s", (update, expected) => {
    expect(affectsComposition(update)).toBe(expected);
  });
});
