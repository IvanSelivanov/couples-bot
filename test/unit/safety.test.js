// T19: набор помощи и реакция на сигналы (DR14, DR18, DR20, DR21).
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMERGENCY_NUMBERS,
  HELPLINE_DIRECTORY,
  emergencyLine,
  handleSignal,
  helpPack,
  pageHasNumber,
  refreshHelpLines,
} from "../../lib/safety.js";

const page = (html, ok = true) => vi.fn().mockResolvedValue({ ok, text: async () => html });

beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => {}));

describe("pageHasNumber: номер проверяется по странице источника", () => {
  it("цифры есть на странице с другими разделителями", async () => {
    expect(await pageHasNumber("https://example.org/help", "016", { fetchFn: page("<p>Llama al 0 1 6</p>") })).toBe(true);
    expect(await pageHasNumber("https://example.org/x", "+34 900 202 010", { fetchFn: page("Tel.: +34-900-202-010") })).toBe(true);
  });

  it("цифр нет — не верим модели", async () => {
    expect(await pageHasNumber("https://example.org/x", "900 202 010", { fetchFn: page("Tel.: 900 111 222") })).toBe(false);
  });

  it("частичное совпадение не считается", async () => {
    expect(await pageHasNumber("https://example.org/x", "+34 900 202 010", { fetchFn: page("202010 visitors") })).toBe(false);
  });

  it("только https и только настоящие имена хостов", async () => {
    const fetchFn = page("016");
    for (const url of ["http://example.org", "https://127.0.0.1/", "https://localhost/", "https://[::1]/", "https://intranet/", "not a url"]) {
      expect(await pageHasNumber(url, "016", { fetchFn })).toBe(false);
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("страница недоступна — нет", async () => {
    expect(await pageHasNumber("https://example.org/x", "016", { fetchFn: page("016", false) })).toBe(false);
    expect(await pageHasNumber("https://example.org/x", "016", { fetchFn: vi.fn().mockRejectedValue(new Error("x")) })).toBe(false);
  });
});

describe("refreshHelpLines", () => {
  const store = () => ({ helpLinesPut: vi.fn() });

  it("в кеш попадают только проверенные строки", async () => {
    const s = store();
    const generateFn = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        lines: [
          { kind: "domestic_violence", name: "Línea 016", phone: "016", source_url: "https://real.example/016" },
          { kind: "mental_health", name: "Выдуманная", phone: "123 456", source_url: "https://fake.example/" },
        ],
      },
    });
    const fetchFn = vi.fn(async (url) => ({ ok: true, text: async () => (String(url).includes("real") ? "016" : "ничего") }));
    const lines = await refreshHelpLines("ES", { store: s, generateFn, fetchFn });
    expect(lines).toEqual([{ kind: "domestic_violence", name: "Línea 016", phone: "016", source_url: "https://real.example/016" }]);
    expect(s.helpLinesPut).toHaveBeenCalledWith("ES", lines, "ok");
    expect(generateFn.mock.calls[0][0].purpose).toBe("help_lines");
  });

  it("модель недоступна — failed, пустой список", async () => {
    const s = store();
    expect(await refreshHelpLines("ES", { store: s, generateFn: vi.fn().mockResolvedValue({ unavailable: "quota" }) })).toEqual([]);
    expect(s.helpLinesPut).toHaveBeenCalledWith("ES", [], "failed");
  });
});

describe("helpPack (DR18, DR21)", () => {
  const textFn = async (lang, key) => `${lang}:${key}`;
  const cached = [{ country: "ES", lines: [{ kind: "domestic_violence", name: "Línea 016", phone: "016" }] }];

  it("нейтральная первая строка, оба языка, строки стран, экстренные номера, каталог", async () => {
    const pack = await helpPack({ langs: ["ru", "es"], countries: ["ES", "RU"], cached }, { textFn });
    // Первая видимая строка (превью на заблокированном экране) — нейтральная.
    expect(pack.startsWith("<b>ru:safety.neutral_first_line\nes:safety.neutral_first_line</b>")).toBe(true);
    expect(pack).toContain("Línea 016 (ES): 016");
    expect(pack).toContain("ES: 112");
    expect(pack).toContain("RU: 112");
    expect(pack.trim().endsWith(HELPLINE_DIRECTORY)).toBe(true);
  });

  it("текст не зависит от получателя и не называет причину", async () => {
    const a = await helpPack({ langs: ["ru", "es"], countries: ["ES"], cached }, { textFn });
    const b = await helpPack({ langs: ["ru", "es"], countries: ["ES"], cached }, { textFn });
    expect(a).toBe(b);
    for (const word of ["abuse", "насил", "crisis", "жалоб"]) expect(a.toLowerCase()).not.toContain(word);
  });

  it("без кеша и без известной страны — только каталог (без модели)", async () => {
    const pack = await helpPack({ langs: ["ru"], countries: ["ZZ"], cached: [] }, { textFn });
    expect(pack).toContain(HELPLINE_DIRECTORY);
  });

  it("экстренная строка для группы", () => {
    expect(emergencyLine(["ES", "DE"])).toBe("SOS: 112");
    expect(emergencyLine(["US", "ES"])).toBe("SOS: 911 / 112");
    expect(emergencyLine(["ZZ"])).toBe(`SOS: ${HELPLINE_DIRECTORY}`);
    expect(EMERGENCY_NUMBERS.GB).toBe("999");
  });
});

describe("handleSignal", () => {
  const context = {
    coupleId: 7,
    groupChatId: -100,
    members: [
      { userId: 1, lang: "ru" },
      { userId: 2, lang: "es" },
    ],
  };
  function deps({ failFor } = {}) {
    const sent = [];
    const store = {
      addAbuseFlag: vi.fn(),
      coupleTransition: vi.fn().mockResolvedValue({ ok: true }),
      coupleCountries: vi.fn().mockResolvedValue(["ES"]),
      helpLinesGet: vi.fn().mockResolvedValue([]),
    };
    return {
      sent,
      store,
      text: async (lang, key) => `${lang}:${key}`,
      deliver: vi.fn(async (m) => {
        sent.push(m);
        return { status: m.chatId === failFor ? "failed" : "sent" };
      }),
    };
  }

  it("abuse в группе: флаг group, одинаковый набор обоим, нейтральная строка в группе", async () => {
    const d = deps();
    await handleSignal({ signal: "abuse", surface: "group", context, windowId: 3 }, d);
    expect(d.store.addAbuseFlag).toHaveBeenCalledWith(7, "group");
    expect(d.store.coupleTransition).not.toHaveBeenCalled();
    const dms = d.sent.filter((m) => m.scope === "dm");
    expect(dms.map((m) => m.chatId)).toEqual([1, 2]);
    expect(dms[0].params.text).toBe(dms[1].params.text);
    const group = d.sent.find((m) => m.scope === "group");
    expect(group.params.text).toBe("ru:safety.group_line\nes:safety.group_line");
  });

  it("crisis в группе: переход crisis и строка экстренного номера", async () => {
    const d = deps();
    await handleSignal({ signal: "crisis", surface: "group", context, windowId: 3 }, d);
    expect(d.store.coupleTransition).toHaveBeenCalledWith(7, "crisis");
    expect(d.sent.find((m) => m.scope === "group").params.text).toContain("SOS: 112");
  });

  it("сигнал из лички X: набор только X, флаг dm:X, группа и Y ничего не получают", async () => {
    const d = deps();
    await handleSignal({ signal: "abuse", surface: "dm", context, fromUserId: 1 }, d);
    expect(d.store.addAbuseFlag).toHaveBeenCalledWith(7, "dm:1");
    expect(d.sent.map((m) => m.chatId)).toEqual([1]);
  });

  it("личка одного не доставлена: группа и второй получают своё как обычно", async () => {
    const d = deps({ failFor: 2 });
    await handleSignal({ signal: "abuse", surface: "group", context, windowId: 3 }, d);
    const group = d.sent.find((m) => m.scope === "group");
    expect(group.params.text).toBe("ru:safety.group_line\nes:safety.group_line");
    expect(d.sent.filter((m) => m.scope === "dm")).toHaveLength(2);
  });

  it("повтор сигнала не шлёт второй раз: ключи outbox стабильны", async () => {
    const d = deps();
    await handleSignal({ signal: "abuse", surface: "group", context, windowId: 3 }, d);
    const keys = d.sent.map((m) => m.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain("safety:group:3:abuse:1");
  });
});
