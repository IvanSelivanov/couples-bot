// T16 + T34: двуязычный формат, кнопки, уведомления, разбиение (DR1, DR17, DR18, R29).
import { describe, expect, it } from "vitest";
import { FormatError, bilingual, keyboard, notification, pauseMessages, translationBlock } from "../../lib/format.js";

describe("bilingual (DR1)", () => {
  it("язык адресата первым с меткой, второй — свёрнутая цитата", () => {
    const html = bilingual({
      heading: "Вопрос к Марии",
      primary: { lang: "es", text: "¿Qué te dolió más?" },
      secondary: { lang: "ru", text: "Что задело тебя больше всего?" },
    });
    expect(html).toBe(
      "<b>Вопрос к Марии · ES</b>\n¿Qué te dolió más?\n<blockquote expandable>RU ▸ Что задело тебя больше всего?</blockquote>",
    );
  });

  it("один язык у пары — без меток и без дубля", () => {
    const html = bilingual({ primary: { lang: "ru", text: "Привет" }, secondary: { lang: "ru-RU", text: "Привет" } });
    expect(html).toBe("Привет");
  });

  it("экранирует HTML в тексте модели", () => {
    expect(bilingual({ primary: { lang: "ru", text: "<script> & co" } })).toBe("&lt;script&gt; &amp; co");
  });
});

describe("notification (DR18)", () => {
  it.each([
    ["translation", true],
    ["recap", true],
    ["status", true],
    ["quota", true],
    ["mediator", false],
    ["check", false],
    ["crisis", false],
  ])("%s без звука: %s", (kind, silent) => {
    expect(Boolean(notification(kind).disable_notification)).toBe(silent);
  });

  it("неизвестный вид — ошибка программиста", () => {
    expect(() => notification("nope")).toThrow(FormatError);
  });
});

describe("keyboard (DR17)", () => {
  it("много коротких кнопок — строки по 3, подписи не обрезаются", () => {
    const names = ["English", "Русский", "Español", "Deutsch", "Français", "Italiano", "Português", "Українська"];
    const kb = keyboard(names.map((n, i) => ({ labels: [n], data: `l${i}` })));
    expect(kb.inline_keyboard.map((row) => row.map((b) => b.text))).toEqual([
      ["English", "Русский", "Español"],
      ["Deutsch", "Français", "Italiano"],
      ["Português", "Українська"],
    ]);
  });

  it("строка не шире 30 символов подписей", () => {
    const kb = keyboard([
      { labels: ["Двенадцать12"], data: "a" },
      { labels: ["Двенадцать12"], data: "b" },
      { labels: ["Двенадцать12"], data: "c" },
    ]);
    expect(kb.inline_keyboard.map((row) => row.length)).toEqual([2, 1]);
  });

  it("короткие двуязычные подписи — в одну строку", () => {
    const kb = keyboard([
      { labels: ["Слово", "Palabra"], data: "a" },
      { labels: ["Да", "Sí"], data: "b" },
    ]);
    expect(kb.inline_keyboard).toEqual([[{ text: "Слово · Palabra", callback_data: "a" }, { text: "Да · Sí", callback_data: "b" }]]);
  });

  it("длинная подпись — каждая кнопка на своей строке", () => {
    const kb = keyboard([
      { labels: ["Меня поняли верно", "I was understood"], data: "a" },
      { labels: ["Уточнить смысл", "Clarify meaning"], data: "b" },
    ]);
    expect(kb.inline_keyboard).toHaveLength(2);
  });

  it("одинаковые подписи не дублируются", () => {
    expect(keyboard([{ labels: ["OK", "OK"], data: "a" }]).inline_keyboard[0][0].text).toBe("OK");
  });

  it("callback_data длиннее 64 байт — ошибка", () => {
    expect(() => keyboard([{ labels: ["x"], data: "я".repeat(40) }])).toThrow(/64 байт/);
  });

  it("URL-кнопка", () => {
    expect(keyboard([{ labels: ["Мария → открыть бота"], url: "https://t.me/bot?start=x" }]).inline_keyboard[0][0]).toEqual({
      text: "Мария → открыть бота",
      url: "https://t.me/bot?start=x",
    });
  });
});

describe("pauseMessages (R29)", () => {
  const tr = (messageId, len = 10) => ({ messageId, lang: "es", text: "a".repeat(len) });

  it("ответ и переводы в лимите — одно сообщение со звуком", () => {
    const parts = pauseMessages({ chatId: -1, replyHtml: "Ответ", translations: [tr(1), tr(2)] });
    expect(parts).toHaveLength(1);
    expect(parts[0].params.text).toBe(`Ответ\n\n${translationBlock(tr(1))}\n\n${translationBlock(tr(2))}`);
    expect(parts[0].params.disable_notification).toBeUndefined();
  });

  it("переводы сверх лимита — отдельными тихими реплаями на свои реплики", () => {
    const parts = pauseMessages({ chatId: -1, replyHtml: "Ответ", translations: [tr(1, 60), tr(2, 60), tr(3, 60)], limit: 200 });
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.params.text.length).toBeLessThanOrEqual(200);
    const tail = parts.slice(1);
    expect(tail.every((p) => p.params.disable_notification === true)).toBe(true);
    expect(tail.map((p) => p.params.reply_parameters.message_id)).toEqual([2, 3]);
  });

  it("порядок переводов сохраняется: после первого не влезшего все идут отдельно", () => {
    const parts = pauseMessages({ chatId: -1, replyHtml: "Ответ", translations: [tr(1, 150), tr(2, 5)], limit: 120 });
    expect(parts[0].params.text).toBe("Ответ");
    expect(parts.slice(1).map((p) => p.params?.reply_parameters?.message_id ?? p.document.reply_to)).toEqual([1, 2]);
  });

  it("перевод длиннее лимита сам по себе — файлом реплаем на реплику", () => {
    const parts = pauseMessages({ chatId: -1, replyHtml: null, translations: [tr(7, 500)], limit: 100 });
    expect(parts).toEqual([
      expect.objectContaining({ method: "sendDocument", document: expect.objectContaining({ reply_to: 7, content: "a".repeat(500) }) }),
    ]);
  });

  it("speak=false — только переводы, по одному реплаю на реплику (DR2)", () => {
    const parts = pauseMessages({ chatId: -1, replyHtml: null, translations: [tr(1), tr(2)] });
    expect(parts.map((p) => p.params.reply_parameters.message_id)).toEqual([1, 2]);
  });

  it("экранирование считается в длине", () => {
    const parts = pauseMessages({ chatId: -1, replyHtml: "x", translations: [{ messageId: 1, lang: "es", text: "<".repeat(30) }], limit: 60 });
    expect(parts).toHaveLength(2);
  });

  it("ответ ведущего длиннее лимита — ошибка, а не обрезка", () => {
    expect(() => pauseMessages({ chatId: -1, replyHtml: "x".repeat(50), limit: 10 })).toThrow(FormatError);
  });
});

describe("toSendArgs", () => {
  it("файл превращается в FormData с реплаем и без звука", async () => {
    const { toSendArgs } = await import("../../lib/format.js");
    const [part] = pauseMessages({ chatId: -5, replyHtml: null, translations: [{ messageId: 3, lang: "es", text: "b".repeat(50) }], limit: 10 });
    const { method, params } = toSendArgs(part);
    expect(method).toBe("sendDocument");
    expect(params.get("chat_id")).toBe("-5");
    expect(JSON.parse(params.get("reply_parameters"))).toEqual({ message_id: 3 });
    expect(params.get("disable_notification")).toBe("true");
    expect(await params.get("document").text()).toBe("b".repeat(50));
  });
});
