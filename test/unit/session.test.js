// T6: the "person has finished talking" debounce (R1, R11) on fake timers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEBOUNCE_MS, MAX_WAIT_MS, decide, onPartnerMessage, onTranscript, runCheck, schedule } from "../../lib/session.js";

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

// End-to-end scenario on background sleep and fake timers: the database is emulated in
// memory, and respond moves the marker to the latest message, as a real reply would.
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
      windowCouple: async () => 1,
      expireTranscripts: async () => 0,
      debounceState: async () => ({
        answeredUpTo,
        latestId: messages.length ? Math.max(...messages) : null,
        firstUnansweredId: messages.find((id) => id > answeredUpTo) ?? null,
        ended: false,
      }),
    };
    const respond = async (_windowId, marker) => {
      if (marker !== answeredUpTo) return; // a lease on a stale marker isn't taken
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

describe("ожидание расшифровки (R22, R26)", () => {
  it("pending в блоке — ведущий ждёт", () => {
    expect(decide({ answeredUpTo: 0, latestId: 3, pendingTranscripts: 1 }, { kind: "debounce", messageId: 3 })).toBe(
      "waiting_transcript",
    );
  });

  it("проверка на потолке отвечает, если блок не покрыт", () => {
    expect(decide({ answeredUpTo: 0, latestId: 5, pendingTranscripts: 0 }, { kind: "transcript_deadline", messageId: 3 })).toBe(
      "respond",
    );
  });

  it("проверка на потолке молчит, если блок уже покрыт", () => {
    expect(decide({ answeredUpTo: 5, latestId: 5, pendingTranscripts: 0 }, { kind: "transcript_deadline", messageId: 3 })).toBe(
      "answered",
    );
  });
});

describe("onTranscript", () => {
  const baseDeps = (result, state) => {
    const store = {
      setTranscript: vi.fn().mockResolvedValue(result),
      debounceState: vi.fn().mockResolvedValue(state),
      queueBudgetTake: vi.fn().mockResolvedValue(true),
    };
    return { store, enqueue: vi.fn().mockResolvedValue({}), defer: vi.fn(), run: vi.fn() };
  };

  it("вовремя: проверка на последнюю реплику, не раньше паузы", async () => {
    const deps = baseDeps({ applied: true, late: false }, { latestId: 9, latestAt: 1_000 });
    deps.now = () => 6_000; // the latest message was 5 s ago
    await onTranscript({ windowId: 1, messageId: 4, text: "t" }, deps);
    expect(deps.enqueue).toHaveBeenCalledWith(
      { windowId: 1, messageId: 9, kind: "debounce" },
      expect.objectContaining({ delaySeconds: Math.ceil((DEBOUNCE_MS - 5_000) / 1000) }),
    );
  });

  it("поздно: ведущего не будим", async () => {
    const deps = baseDeps({ applied: false, late: true }, { latestId: 9, latestAt: 0 });
    expect(await onTranscript({ windowId: 1, messageId: 4, text: "t" }, deps)).toEqual({ applied: false, late: true });
    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(deps.defer).not.toHaveBeenCalled();
  });
});
