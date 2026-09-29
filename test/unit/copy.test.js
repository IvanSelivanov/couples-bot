// T15: the fixed text catalog and machine translation with a cache (DR15, R23, DR17).
import { describe, expect, it, vi } from "vitest";
import ru from "../../lib/copy/ru.js";
import en from "../../lib/copy/en.js";
import { CopyError, fill, sourceHash, text } from "../../lib/copy.js";

const placeholders = (s) => (s.match(/\{\w+\}/g) ?? []).sort();

describe("каталоги", () => {
  it("у ru и en одинаковые ключи", () => {
    expect(Object.keys(ru).sort()).toEqual(Object.keys(en).sort());
  });

  it("плейсхолдеры совпадают у каждого ключа", () => {
    for (const key of Object.keys(en)) expect(placeholders(ru[key]), key).toEqual(placeholders(en[key]));
  });

  it("подписи кнопок не длиннее 24 символов (DR17)", () => {
    for (const catalog of [ru, en]) {
      for (const [key, value] of Object.entries(catalog)) {
        if (key.endsWith("_button") && !value.includes("{")) expect(value.length, `${key}: ${value}`).toBeLessThanOrEqual(24);
      }
    }
  });

  it("в русских текстах бот говорит о себе в мужском роде (DR24)", () => {
    const all = Object.values(ru).join(" ");
    for (const feminine of ["я поняла", "я отправила", "остановилась", "я сказала"]) expect(all).not.toContain(feminine);
  });

  it("запрещённые штампы голоса не попадают в тексты (DR13)", () => {
    const all = Object.values(ru).join(" ").toLowerCase();
    for (const cliche of ["я слышу тебя", "твои чувства валидны", "важно помнить, что", "давайте разберёмся"]) {
      expect(all).not.toContain(cliche);
    }
  });
});

describe("fill", () => {
  it("подставляет параметры", () => {
    expect(fill("через {minutes} мин.", { minutes: 5 })).toBe("через 5 мин.");
  });
  it("без параметра — ошибка программиста", () => {
    expect(() => fill("{name}", {})).toThrow(CopyError);
  });
});

function fakeStore(row = null) {
  return { copyCacheGet: vi.fn().mockResolvedValue(row), copyCachePut: vi.fn().mockResolvedValue() };
}

describe("text", () => {
  it("ru и en — из каталога, без кеша и модели", async () => {
    const store = fakeStore();
    const translateFn = vi.fn();
    expect(await text("ru", "check.success", {}, { store, translateFn })).toBe("Спасибо. Смысл передан.");
    expect(await text("en-US", "check.success", {}, { store, translateFn })).toBe("Thank you. The meaning got through.");
    expect(store.copyCacheGet).not.toHaveBeenCalled();
    expect(translateFn).not.toHaveBeenCalled();
  });

  it("другой язык: свежий кеш — без модели", async () => {
    const store = fakeStore({ text: "Gracias.", source_hash: sourceHash("check.success"), reviewed: true });
    const translateFn = vi.fn();
    expect(await text("es", "check.success", {}, { store, translateFn })).toBe("Gracias.");
    expect(translateFn).not.toHaveBeenCalled();
  });

  it("нет кеша: перевод, запись с хешем исходника", async () => {
    const store = fakeStore(null);
    const translateFn = vi.fn().mockResolvedValue("Gracias. El sentido llegó.");
    expect(await text("es", "check.success", {}, { store, translateFn })).toBe("Gracias. El sentido llegó.");
    expect(store.copyCachePut).toHaveBeenCalledWith({
      lang: "es",
      key: "check.success",
      text: "Gracias. El sentido llegó.",
      sourceHash: sourceHash("check.success"),
      wasReviewed: false,
    });
  });

  it("исходник изменился, а перевод был вычитан — новый перевод и пометка stale (R23)", async () => {
    const store = fakeStore({ text: "старый", source_hash: "устаревший", reviewed: true });
    const translateFn = vi.fn().mockResolvedValue("nuevo");
    await text("es", "check.success", {}, { store, translateFn });
    expect(store.copyCachePut.mock.calls[0][0].wasReviewed).toBe(true);
  });

  it("перевод не удался — английский текст (DR15)", async () => {
    const store = fakeStore(null);
    const translateFn = vi.fn().mockResolvedValue(null);
    expect(await text("es", "check.cooldown", { minutes: 7 }, { store, translateFn })).toBe(
      "You can repeat the exercise in 7 min.",
    );
    expect(store.copyCachePut).not.toHaveBeenCalled();
  });

  it("кеш недоступен — всё равно переводим", async () => {
    const store = { copyCacheGet: vi.fn().mockRejectedValue(new Error("db")), copyCachePut: vi.fn().mockRejectedValue(new Error("db")) };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const translateFn = vi.fn().mockResolvedValue("Gracias.");
    expect(await text("es", "check.success", {}, { store, translateFn })).toBe("Gracias.");
  });

  it("неизвестный ключ — ошибка программиста", async () => {
    await expect(text("ru", "nope.key")).rejects.toThrow(CopyError);
  });
});
