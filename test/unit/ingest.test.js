// T5: приём апдейта до ACK (R10, R19, R1, R27). База и очередь подменены.
import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { acceptUpdate, openUpdate, processUpdate } from "../../lib/ingest.js";

const update = { update_id: 42, message: { chat: { id: 1, type: "private" }, text: "личное" } };

function fakeStore(overrides = {}) {
  return {
    queueBudgetTake: vi.fn().mockResolvedValue(true),
    markReceived: vi.fn().mockResolvedValue("received"),
    markDone: vi.fn().mockResolvedValue(),
    ...overrides,
  };
}

let deps;
beforeEach(() => {
  process.env.DM_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.DM_ENCRYPTION_KEY_VERSION = "1";
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  deps = {
    enqueue: vi.fn().mockResolvedValue({ messageId: "m1" }),
    defer: vi.fn(),
    process: vi.fn().mockResolvedValue("done"),
    store: fakeStore(),
  };
});

describe("acceptUpdate: путь через очередь", () => {
  it("кладёт шифротекст в очередь с ключом идемпотентности и отвечает 200", async () => {
    expect(await acceptUpdate(update, deps)).toBe(200);
    const [message, options] = deps.enqueue.mock.calls[0];
    expect(message.updateId).toBe(42);
    expect(message.payload).not.toMatch(/личное/);
    expect(openUpdate(42, message.payload)).toEqual(update);
    expect(options).toEqual({ idempotencyKey: "update-42" });
    expect(deps.store.markReceived).not.toHaveBeenCalled();
    expect(deps.defer).not.toHaveBeenCalled();
  });

  it("шифротекст привязан к update_id: чужой id не откроет", async () => {
    await acceptUpdate(update, deps);
    const { payload } = deps.enqueue.mock.calls[0][0];
    expect(() => openUpdate(43, payload)).toThrow();
  });

  it("мусор без update_id — 200 без работы", async () => {
    expect(await acceptUpdate({ foo: 1 }, deps)).toBe(200);
    expect(await acceptUpdate(null, deps)).toBe(200);
    expect(deps.enqueue).not.toHaveBeenCalled();
  });

  it("база недоступна при проверке бюджета — всё равно пробуем очередь", async () => {
    deps.store.queueBudgetTake.mockRejectedValue(new Error("db down"));
    expect(await acceptUpdate(update, deps)).toBe(200);
    expect(deps.enqueue).toHaveBeenCalled();
  });
});

describe("acceptUpdate: фолбэк без очереди (R1, R10)", () => {
  it("бюджет Queues ≥ 90% — запись received с шифротекстом и обработка в defer", async () => {
    deps.store.queueBudgetTake.mockResolvedValue(false);
    expect(await acceptUpdate(update, deps)).toBe(200);
    expect(deps.enqueue).not.toHaveBeenCalled();
    const [id, payload] = deps.store.markReceived.mock.calls[0];
    expect(id).toBe(42);
    expect(openUpdate(42, payload)).toEqual(update);
    expect(deps.defer).toHaveBeenCalledOnce();
    expect(deps.process).toHaveBeenCalledWith(update);
  });

  it("ошибка send — тот же фолбэк", async () => {
    deps.enqueue.mockRejectedValue(new Error("queue down"));
    expect(await acceptUpdate(update, deps)).toBe(200);
    expect(deps.store.markReceived).toHaveBeenCalled();
    expect(deps.defer).toHaveBeenCalledOnce();
  });

  it("ни очереди, ни базы — 503, Telegram повторит (R19)", async () => {
    deps.enqueue.mockRejectedValue(new Error("queue down"));
    deps.store.markReceived.mockRejectedValue(new Error("db down"));
    expect(await acceptUpdate(update, deps)).toBe(503);
    expect(deps.defer).not.toHaveBeenCalled();
  });

  it("повтор уже обработанного апдейта в фолбэке — 200 без обработки", async () => {
    deps.enqueue.mockRejectedValue(new Error("queue down"));
    deps.store.markReceived.mockResolvedValue("done");
    expect(await acceptUpdate(update, deps)).toBe(200);
    expect(deps.defer).not.toHaveBeenCalled();
  });

  it("падение фоновой обработки не роняет ответ и логируется без текста", async () => {
    deps.enqueue.mockRejectedValue(new Error("queue down"));
    deps.process.mockRejectedValue(new Error("boom"));
    expect(await acceptUpdate(update, deps)).toBe(200);
    await deps.defer.mock.calls[0][0];
    const logged = console.error.mock.calls.flat().join(" ");
    expect(logged).toMatch(/42/);
    expect(logged).not.toMatch(/личное/);
  });
});

describe("processUpdate (R3, R10)", () => {
  it("новый апдейт: обработка, затем done", async () => {
    const store = fakeStore();
    const handle = vi.fn().mockResolvedValue();
    expect(await processUpdate(update, { handle, store })).toBe("done");
    expect(handle).toHaveBeenCalledWith(update);
    expect(store.markDone).toHaveBeenCalledWith(42);
  });

  it("дубль после done пропускается", async () => {
    const store = fakeStore({ markReceived: vi.fn().mockResolvedValue("done") });
    const handle = vi.fn();
    expect(await processUpdate(update, { handle, store })).toBe("skipped");
    expect(handle).not.toHaveBeenCalled();
  });

  it("падение после вставки: done не ставится, повтор обрабатывается", async () => {
    const store = fakeStore();
    const handle = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce();
    await expect(processUpdate(update, { handle, store })).rejects.toThrow("boom");
    expect(store.markDone).not.toHaveBeenCalled();
    expect(await processUpdate(update, { handle, store })).toBe("done");
    expect(handle).toHaveBeenCalledTimes(2);
  });
});
