// T11: bot admin and group membership (R17).
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

describe("помощники онбординга (DR5, DR8, T19)", async () => {
  const { offsetFromLocalTime, parseCountry, parseLanguage, signInvite, statusLine, verifyInvite, languageKeyboard } = await import("../../lib/onboarding.js");

  it("время → смещение пояса с шагом 15 минут", () => {
    const now = Date.UTC(2026, 8, 28, 12, 0);
    expect(offsetFromLocalTime("14:30", now)).toBe("+02:30");
    expect(offsetFromLocalTime("9:05", now)).toBe("-03:00");
    // 01:00 at 12:00 UTC is both +13 and −11; −11 is chosen (range −12…+14).
    expect(offsetFromLocalTime("01:00", now)).toBe("-11:00");
    expect(offsetFromLocalTime("23:00", Date.UTC(2026, 8, 28, 1, 0))).toBe("-02:00");
    expect(offsetFromLocalTime("25:00", now)).toBeNull();
    expect(offsetFromLocalTime("полдень", now)).toBeNull();
  });

  it("страна по названию на разных языках и по коду", () => {
    expect(parseCountry("Испания", ["ru"])).toBe("ES");
    expect(parseCountry("españa", ["es"])).toBe("ES");
    expect(parseCountry("Germany")).toBe("DE");
    expect(parseCountry("de")).toBe("DE");
    expect(parseCountry("Нарния", ["ru"])).toBeNull();
  });

  it("ссылка приглашения подписана и не подделывается", () => {
    process.env.WEBHOOK_SECRET = "s1";
    const token = signInvite(42);
    expect(verifyInvite(token)).toBe(42);
    expect(verifyInvite(token.replace("g42", "g43"))).toBeNull();
    expect(verifyInvite("g42_AAAAAAAAAAAAAAAA")).toBeNull();
    expect(token.length).toBeLessThanOrEqual(64);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("статус с неизвестным партнёром", () => {
    expect(statusLine([{ name: "Иван", consentedAt: "x" }])).toBe("✅ Иван · ⏳ …");
    expect(statusLine([{ name: "Иван", consentedAt: "x" }, { name: "María", consentedAt: null }])).toBe("✅ Иван · ⏳ María");
  });

  it("язык из Telegram — первой кнопкой (DR8)", () => {
    expect(languageKeyboard("es-ES").inline_keyboard.flat()[0].callback_data).toBe("ob:lang:es");
  });

  it("кнопка «Другой язык» — последней", () => {
    const rows = languageKeyboard("ru", "Другой язык").inline_keyboard;
    expect(rows.flat()).toHaveLength(9);
    // On its own row: in a row of three the label gets cut to «Друг…язык».
    expect(rows.at(-1)).toEqual([{ text: "Другой язык", callback_data: "ob:lang:other" }]);
  });

  it("язык по названию: на языке пользователя, по-английски, самоназванием, кодом", () => {
    expect(parseLanguage("турецкий", ["ru"])).toBe("tr");
    expect(parseLanguage("Turkish")).toBe("tr");
    expect(parseLanguage("Türkçe")).toBe("tr");
    expect(parseLanguage("  Polski ")).toBe("pl");
    expect(parseLanguage("japonés", ["es"])).toBe("ja");
    expect(parseLanguage("ka")).toBe("ka");
    expect(parseLanguage("эльфийский", ["ru"])).toBeNull();
    expect(parseLanguage("")).toBeNull();
  });
});

describe("отказ команды объясняет причину", async () => {
  const { refusalKey } = await import("../../lib/commands.js");
  it.each([
    [{ reason: "not_active", state: "onboarding" }, "pause", "state.why_onboarding"],
    [{ reason: "not_active", state: "paused" }, "pause", "state.why_paused"],
    [{ reason: "not_allowed", state: "revoked" }, "revoke", "state.why_revoked"],
    [{ reason: "not_active", state: "suspended" }, "pause", "state.why_suspended"],
    [{ reason: "not_paused", state: "active" }, "resume", "state.not_paused"],
    [{ reason: "not_revoked", state: "active" }, "consent", "data.consent_already"],
    [{ reason: "not_pauser", state: "paused" }, "resume", "state.resume_not_pauser"],
  ])("%j %s → %s", (t, op, key) => {
    expect(refusalKey(t, op)).toBe(key);
  });
});
