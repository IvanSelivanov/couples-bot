// T4: the Gemini wrapper contract (R5). Network and database are stubbed.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/db.js", () => ({ quotaTake: vi.fn() }));

const { quotaTake } = await import("../../lib/db.js");
const { generate, classifyBlock, deadlineIn } = await import("../../lib/gemini.js");

const SCHEMA = { type: "OBJECT", properties: { reply: { type: "STRING" } } };

function okResponse(text) {
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }] }), {
    status: 200,
  });
}
function statusResponse(status, body = "{}", headers = {}) {
  return new Response(body, { status, headers });
}
function blockedResponse({ finishReason = "SAFETY", category, promptBlock } = {}) {
  const ratings = category ? [{ category, probability: "HIGH", blocked: true }] : [];
  const payload = promptBlock
    ? { promptFeedback: { blockReason: promptBlock, safetyRatings: ratings } }
    : { candidates: [{ finishReason, safetyRatings: ratings }] };
  return new Response(JSON.stringify(payload), { status: 200 });
}

let fetchMock;
beforeEach(() => {
  process.env.GEMINI_API_KEY = "test-key";
  process.env.GEMINI_DAILY_LIMIT = "100";
  quotaTake.mockReset().mockResolvedValue({ allowed: true, used: 10 });
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const call = (extra = {}) => generate({ purpose: "pause", parts: [{ text: "привет" }], schema: SCHEMA, ...extra });

describe("успешный вызов", () => {
  it("возвращает разобранный JSON и долю квоты", async () => {
    fetchMock.mockResolvedValue(okResponse('{"reply":"да"}'));
    expect(await call()).toEqual({ ok: true, data: { reply: "да" }, usage: 0.1 });
  });

  it("без схемы возвращает строку", async () => {
    fetchMock.mockResolvedValue(okResponse("  текст  "));
    expect(await call({ schema: undefined })).toEqual({ ok: true, data: "текст", usage: 0.1 });
  });

  it("передаёт уровень вызова в квоту и минимальную блокировку в safetySettings", async () => {
    fetchMock.mockResolvedValue(okResponse('{"reply":"да"}'));
    await generate({ purpose: "fold", parts: [{ text: "x" }], schema: SCHEMA });
    expect(quotaTake).toHaveBeenCalledWith(100, 70);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.safetySettings.every((s) => s.threshold === "BLOCK_NONE")).toBe(true);
  });

  it("неизвестное назначение — ошибка программиста, а не фолбэк", async () => {
    await expect(generate({ purpose: "nope", parts: [] })).rejects.toThrow(/неизвестное назначение/);
  });
});

describe("квота", () => {
  it("исчерпанный уровень — без запроса к модели", async () => {
    quotaTake.mockResolvedValue({ allowed: false, used: 90 });
    expect(await call()).toEqual({ unavailable: "quota", reason: "level" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("каждая попытка списывается из квоты", async () => {
    fetchMock.mockResolvedValueOnce(statusResponse(503)).mockResolvedValueOnce(okResponse('{"reply":"да"}'));
    await call();
    expect(quotaTake).toHaveBeenCalledTimes(2);
  });

  it("квота кончилась между попытками — останавливаемся", async () => {
    quotaTake.mockResolvedValueOnce({ allowed: true, used: 89 }).mockResolvedValueOnce({ allowed: false, used: 90 });
    fetchMock.mockResolvedValue(statusResponse(503));
    expect(await call()).toEqual({ unavailable: "quota", reason: "level" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("повторы", () => {
  it("5xx повторяется один раз", async () => {
    fetchMock.mockResolvedValueOnce(statusResponse(500)).mockResolvedValueOnce(okResponse('{"reply":"да"}'));
    expect((await call()).ok).toBe(true);
  });

  it("два 5xx подряд — ошибка", async () => {
    fetchMock.mockImplementation(async () => statusResponse(502));
    expect(await call()).toEqual({ unavailable: "error", reason: "http_502" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("сетевой сбой повторяется один раз", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(okResponse('{"reply":"да"}'));
    expect((await call()).ok).toBe(true);
  });

  it("4xx не повторяется", async () => {
    fetchMock.mockResolvedValue(statusResponse(400));
    expect(await call()).toEqual({ unavailable: "error", reason: "http_400" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("429 повторяется один раз через Retry-After", async () => {
    fetchMock
      .mockResolvedValueOnce(statusResponse(429, "{}", { "retry-after": "0.01" }))
      .mockResolvedValueOnce(okResponse('{"reply":"да"}'));
    expect((await call()).ok).toBe(true);
  });

  it("429 с ожиданием больше дедлайна — сразу квота", async () => {
    fetchMock.mockResolvedValue(statusResponse(429, "{}", { "retry-after": "30" }));
    expect(await call({ deadline: deadlineIn(5_000) })).toEqual({ unavailable: "quota", reason: "429" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("два 429 подряд — квота", async () => {
    fetchMock.mockImplementation(async () => statusResponse(429, "{}", { "retry-after": "0.01" }));
    expect(await call()).toEqual({ unavailable: "quota", reason: "429" });
  });

  it("задержка 429 из тела ответа Google (RetryInfo)", async () => {
    const body = JSON.stringify({
      error: { details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "0.01s" }] },
    });
    fetchMock.mockResolvedValueOnce(statusResponse(429, body)).mockResolvedValueOnce(okResponse('{"reply":"да"}'));
    expect((await call()).ok).toBe(true);
  });

  it("непарсящийся ответ повторяется один раз", async () => {
    fetchMock.mockResolvedValueOnce(okResponse("не json")).mockResolvedValueOnce(okResponse('{"reply":"да"}'));
    expect((await call()).ok).toBe(true);
  });

  it("дважды непарсящийся ответ — нейтральная ошибка", async () => {
    fetchMock.mockImplementation(async () => okResponse("не json"));
    expect(await call()).toEqual({ unavailable: "error", reason: "parse" });
  });

  it("истёкший общий бюджет — без запроса", async () => {
    const deadline = AbortSignal.abort();
    expect(await call({ deadline })).toEqual({ unavailable: "error", reason: "deadline" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("блокировки фильтром", () => {
  it("SAFETY по опасному контенту — crisis", async () => {
    fetchMock.mockResolvedValue(blockedResponse({ category: "HARM_CATEGORY_DANGEROUS_CONTENT" }));
    expect(await call()).toEqual({ blocked: "crisis" });
  });

  it("SAFETY по харассменту в промпте — crisis", async () => {
    fetchMock.mockResolvedValue(blockedResponse({ promptBlock: "SAFETY", category: "HARM_CATEGORY_HARASSMENT" }));
    expect(await call()).toEqual({ blocked: "crisis" });
  });

  it("SAFETY по интимному — neutral, без ложной тревоги", async () => {
    fetchMock.mockResolvedValue(blockedResponse({ category: "HARM_CATEGORY_SEXUALLY_EXPLICIT" }));
    expect(await call()).toEqual({ blocked: "neutral" });
  });

  it("PROHIBITED_CONTENT — neutral", async () => {
    fetchMock.mockResolvedValue(blockedResponse({ finishReason: "PROHIBITED_CONTENT" }));
    expect(await call()).toEqual({ blocked: "neutral" });
  });

  it("SAFETY без категорий — neutral", async () => {
    expect(classifyBlock({ candidates: [{ finishReason: "SAFETY" }] })).toBe("neutral");
  });

  it("блокировка не повторяется", async () => {
    fetchMock.mockResolvedValue(blockedResponse({ category: "HARM_CATEGORY_DANGEROUS_CONTENT" }));
    await call();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("логи без текста", () => {
  it("в лог не попадает ни текст запроса, ни ответ", async () => {
    fetchMock.mockImplementation(async () => okResponse("секретный ответ"));
    await generate({ purpose: "dm_reply", parts: [{ text: "секретный вопрос" }], schema: SCHEMA });
    const logged = console.warn.mock.calls.flat().join(" ");
    expect(logged).not.toMatch(/секретн/);
  });
});

describe("единственная точка (статическая проверка R5)", () => {
  it("только lib/gemini.js обращается к API Gemini", () => {
    const files = [];
    for (const dir of ["lib", "api"]) {
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
      walk(dir);
    }
    const offenders = files.filter(
      (f) => f !== join("lib", "gemini.js") && readFileSync(f, "utf8").includes("generativelanguage.googleapis.com"),
    );
    expect(offenders).toEqual([]);
  });
});
