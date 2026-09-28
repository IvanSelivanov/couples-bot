// T6: дебаунс «человек договорил» (R1, R11) на fake timers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEBOUNCE_MS, MAX_WAIT_MS, decide, onPartnerMessage, runCheck, schedule } from "../../lib/session.js";

describe("decide", () => {
  const state = (answeredUpTo, latestId) => ({ answeredUpTo, latestId, ended: false });

  it.each([
    ["последняя реплика, ничего не отвечено", state(0, 3), { kind: "debounce", messageId: 3 }, "respond"],
    ["есть реплика новее", state(0, 4), { kind: "debounce", messageId: 3 }, "superseded"],
    ["всё уже покрыто ответом", state(4, 4), { kind: "debounce", messageId: 4 }, "answered"],
    ["max_wait при непокрытом блоке отвечает, даже если есть новее", state(0, 9), { kind: "max_wait", messageId: 1 }, "respond"],
    ["max_wait при покрытом блоке молчит", state(5, 9), { kind: "max_wait", messageId: 1 }, "answered"],
    ["окно закрыто", { answeredUpTo: 0, latestId: 3, ended: true }, { kind: "debounce", messageId: 3 }, "answered"],
    ["окна нет", null, { kind: "debounce", messageId: 3 }, "answered"],
  ])("%s", (_name, s, check, expected) => {
    expect(decide(s, check)).toBe(expected);
  });
});

describe("schedule: где ждать (R1)", () => {
  const check = { windowId: 1, messageId: 7, kind: "debounce" };
  let deps;
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    deps = {
      enqueue: vi.fn().mockResolvedValue({}),
      defer: vi.fn(),
      run: vi.fn(),
      store: { queueBudgetTake: vi.fn().mockResolvedValue(true) },
    };
  });
  afterEach(() => vi.restoreAllMocks());

  it("в пределах бюджета — отложенное сообщение с delaySeconds и ключом идемпотентности", async () => {
    expect(await schedule(check, 20_000, deps)).toBe("queue");
    expect(deps.enqueue).toHaveBeenCalledWith(check, { delaySeconds: 20, idempotencyKey: "debounce-1-7" });
    expect(deps.defer).not.toHaveBeenCalled();
  });

  it("бюджет ≥ 90% — сон в фоне", async () => {
    deps.store.queueBudgetTake.mockResolvedValue(false);
    expect(await schedule(check, 20_000, deps)).toBe("sleep");
    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(deps.defer).toHaveBeenCalledOnce();
  });

  it("ошибка send — сон в фоне", async () => {
    deps.enqueue.mockRejectedValue(new Error("down"));
    expect(await schedule(check, 20_000, deps)).toBe("sleep");
  });

  it("без очереди (локальный режим) — сон, бюджет не тратится", async () => {
    delete deps.enqueue;
    expect(await schedule(check, 20_000, deps)).toBe("sleep");
    expect(deps.store.queueBudgetTake).not.toHaveBeenCalled();
  });

  it("сон действительно ждёт delayMs", async () => {
    vi.useFakeTimers();
    try {
      delete deps.enqueue;
      await schedule(check, 20_000, deps);
      await vi.advanceTimersByTimeAsync(19_999);
      expect(deps.run).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(deps.run).toHaveBeenCalledWith(check);
    } finally {
      vi.useRealTimers();
    }
  });
});

// Сквозной сценарий на сне в фоне и fake timers: база эмулируется в памяти,
// respond сдвигает маркер на последнюю реплику, как сделает настоящий ответ.
describe("сквозной дебаунс без очереди", () => {
  let messages;
  let answeredUpTo;
  let responses;
  let deps;
  let nextId;

  beforeEach(() => {
    vi.useFakeTimers();
    messages = [];
    answeredUpTo = 0;
    responses = [];
    nextId = 1;
    const store = {
      debounceState: async () => ({
        answeredUpTo,
        latestId: messages.length ? Math.max(...messages) : null,
        firstUnansweredId: messages.find((id) => id > answeredUpTo) ?? null,
        ended: false,
      }),
    };
    const respond = async (_windowId, marker) => {
      if (marker !== answeredUpTo) return; // аренда по устаревшему маркеру не берётся
      answeredUpTo = Math.max(...messages);
      responses.push({ at: Date.now(), covers: answeredUpTo });
    };
    deps = {
      defer: () => {},
      store,
      run: (check) => runCheck(check, { respond, store }),
    };
  });
  afterEach(() => vi.useRealTimers());

  async function say(atMs) {
    await vi.advanceTimersByTimeAsync(atMs - Date.now());
    const id = nextId++;
    messages.push(id);
    await onPartnerMessage({ windowId: 1, messageId: id }, deps);
  }

  it("одна реплика — ответ через DEBOUNCE", async () => {
    vi.setSystemTime(0);
    await say(0);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(responses).toEqual([{ at: DEBOUNCE_MS, covers: 1 }]);
  });

  it("реплики каждые 10 с — ответ по MAX_WAIT, не позже", async () => {
    vi.setSystemTime(0);
    for (let t = 0; t <= 70_000; t += 10_000) await say(t);
    await vi.advanceTimersByTimeAsync(MAX_WAIT_MS);
    expect(responses[0].at).toBe(MAX_WAIT_MS);
    expect(responses.length).toBeGreaterThanOrEqual(2);
  });

  it("пауза после серии — один ответ на весь блок", async () => {
    vi.setSystemTime(0);
    await say(0);
    await say(5_000);
    await say(9_000);
    await vi.advanceTimersByTimeAsync(MAX_WAIT_MS * 2);
    expect(responses).toEqual([{ at: 9_000 + DEBOUNCE_MS, covers: 3 }]);
  });

  it("MAX_WAIT ставится только первой неотвеченной репликой блока", async () => {
    vi.setSystemTime(0);
    const run = vi.fn();
    const counting = { ...deps, run };
    messages.push(1);
    await onPartnerMessage({ windowId: 1, messageId: 1 }, counting);
    messages.push(2);
    await onPartnerMessage({ windowId: 1, messageId: 2 }, counting);
    await vi.advanceTimersByTimeAsync(MAX_WAIT_MS);
    const kinds = run.mock.calls.map(([c]) => `${c.kind}:${c.messageId}`);
    expect(kinds.sort()).toEqual(["debounce:1", "debounce:2", "max_wait:1"]);
  });
});
