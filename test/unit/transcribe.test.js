// T27: расшифровка и показ транскрипта (DR25, R22).
import { describe, expect, it, vi } from "vitest";
import { showSummary, transcribeMedia, transcriptParts } from "../../lib/transcribe.js";

const ok = (overrides = {}) => ({
  ok: true,
  transcript: "Купи хлеб и молоко",
  lang: "ru",
  summary: "Просит купить хлеб и молоко",
  charged: false,
  translation: "Compra pan y leche",
  usage: 0.1,
  ...overrides,
});

describe("showSummary (DR25)", () => {
  const base = { surface: "group", durationSeconds: 90, charged: false, usage: 0.1, summary: "кратко" };
  it("бытовое голосовое от 60 с в группе — да", () => expect(showSummary(base)).toBe(true));
  it("эмоциональное — нет", () => expect(showSummary({ ...base, charged: true })).toBe(false));
  it("короче 60 с — нет", () => expect(showSummary({ ...base, durationSeconds: 59 })).toBe(false));
  it("в личке — нет", () => expect(showSummary({ ...base, surface: "dm" })).toBe(false));
  it("квота от 70% — нет (R20)", () => expect(showSummary({ ...base, usage: 0.7 })).toBe(false));
});

describe("transcriptParts", () => {
  const common = { chatId: -1, replyTo: 55, targetLang: "es", summaryLabel: "Кратко", fileNotice: "Файлом." };

  it("транскрипт всегда, перевод в том же сообщении, реплай на голосовое, тихо", () => {
    const [part] = transcriptParts({ ...common, surface: "group", durationSeconds: 10, result: ok() });
    expect(part.params.text).toBe(
      "<blockquote expandable>RU ▸ Купи хлеб и молоко</blockquote>\n<blockquote expandable>ES ▸ Compra pan y leche</blockquote>",
    );
    expect(part.params.reply_parameters).toEqual({ message_id: 55 });
    expect(part.params.disable_notification).toBe(true);
  });

  it("один язык у пары — транскрипт без перевода", () => {
    const [part] = transcriptParts({ ...common, targetLang: "ru", surface: "group", durationSeconds: 10, result: ok({ translation: "" }) });
    expect(part.params.text).toBe("<blockquote expandable>RU ▸ Купи хлеб и молоко</blockquote>");
  });

  it("саммари сверху для длинного бытового", () => {
    const [part] = transcriptParts({ ...common, surface: "group", durationSeconds: 90, result: ok() });
    expect(part.params.text.startsWith("<b>Кратко</b>\nПросит купить хлеб и молоко\n\n")).toBe(true);
  });

  it("эмоциональное длинное — без саммари, только слова", () => {
    const [part] = transcriptParts({ ...common, surface: "group", durationSeconds: 90, result: ok({ charged: true }) });
    expect(part.params.text).not.toContain("Кратко");
  });

  it("длиннее лимита — пометка и файлы транскрипта и перевода", () => {
    const parts = transcriptParts({ ...common, surface: "group", durationSeconds: 10, result: ok({ transcript: "а".repeat(300) }), limit: 100 });
    expect(parts.map((p) => p.method)).toEqual(["sendMessage", "sendDocument", "sendDocument"]);
    expect(parts[0].params.text).toBe("Файлом.");
    expect(parts[1].document).toMatchObject({ reply_to: 55, content: "а".repeat(300) });
  });

  it("в личке звук не выключается", () => {
    const [part] = transcriptParts({ ...common, surface: "dm", durationSeconds: 10, result: ok() });
    expect(part.params.disable_notification).toBeUndefined();
  });
});

describe("transcribeMedia", () => {
  it("уровень квоты по поверхности, кружок в низком разрешении", async () => {
    const generateFn = vi.fn().mockResolvedValue({ ok: true, usage: 0.2, data: { transcript: "t", lang: "ru", summary: "", charged: false, translation: "" } });
    await transcribeMedia({ bytes: Buffer.from("x"), mimeType: "video/mp4", surface: "group", targetLang: "es" }, { generateFn });
    expect(generateFn.mock.calls[0][0]).toMatchObject({ purpose: "transcribe_group", mediaResolution: "MEDIA_RESOLUTION_LOW", timeoutMs: 120_000 });
    await transcribeMedia({ bytes: Buffer.from("x"), mimeType: "audio/ogg", surface: "dm", targetLang: "es" }, { generateFn });
    expect(generateFn.mock.calls[1][0]).toMatchObject({ purpose: "transcribe_dm", mediaResolution: undefined });
  });

  it("пустой транскрипт — ошибка, а не пустое сообщение", async () => {
    const generateFn = vi.fn().mockResolvedValue({ ok: true, usage: 0, data: { transcript: "  ", lang: "ru", summary: "", charged: false, translation: "" } });
    expect(await transcribeMedia({ bytes: Buffer.from("x"), mimeType: "audio/ogg", surface: "dm", targetLang: "ru" }, { generateFn })).toEqual({
      unavailable: "error",
      reason: "empty",
    });
  });

  it("блокировка проходит наверх как есть", async () => {
    const generateFn = vi.fn().mockResolvedValue({ blocked: "crisis" });
    expect(await transcribeMedia({ bytes: Buffer.from("x"), mimeType: "audio/ogg", surface: "group", targetLang: "ru" }, { generateFn })).toEqual({
      blocked: "crisis",
    });
  });
});
