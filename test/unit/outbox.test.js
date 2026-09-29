// T7: sending without duplicates (R13). Network and database are stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OutcomeUnknown, TelegramError, deliver, send } from "../../lib/telegram.js";
import { FAILED_DELIVERY_TEXT, UNKNOWN_DELIVERY_TEXT, publishDraft } from "../../lib/draft.js";

const ok = (result = { message_id: 77 }) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });
const fail = (status, extra = {}) =>
  new Response(JSON.stringify({ ok: false, description: `err ${status}`, ...extra }), { status });
const netError = (code) => Object.assign(new TypeError("fetch failed"), { cause: { code } });
const timeout = () => Object.assign(new Error("timed out"), { name: "TimeoutError" });

let fetchMock;
beforeEach(() => {
  process.env.BOT_TOKEN = "t";
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function run(promise) {
  const settled = promise.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await vi.runAllTimersAsync();
  return settled;
}

describe("send: повторы только когда точно не отправлено", () => {
  it("успех с первого раза", async () => {
    fetchMock.mockResolvedValue(ok());
    expect((await run(send("sendMessage", { chat_id: 1, text: "x" }))).value).toEqual({ message_id: 77 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("таймаут — OutcomeUnknown без повтора", async () => {
    fetchMock.mockRejectedValue(timeout());
    const { error } = await run(send("sendMessage", {}));
    expect(error).toBeInstanceOf(OutcomeUnknown);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("разрыв после отправки (ECONNRESET) — OutcomeUnknown без повтора", async () => {
    fetchMock.mockRejectedValue(netError("ECONNRESET"));
    const { error } = await run(send("sendMessage", {}));
    expect(error).toBeInstanceOf(OutcomeUnknown);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("соединение не установлено (ECONNREFUSED) — повтор", async () => {
    fetchMock.mockRejectedValueOnce(netError("ECONNREFUSED")).mockResolvedValueOnce(ok());
    expect((await run(send("sendMessage", {}))).value).toEqual({ message_id: 77 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("соединение так и не установлено — явная ошибка «не отправлено»", async () => {
    fetchMock.mockRejectedValue(netError("ENOTFOUND"));
    const { error } = await run(send("sendMessage", {}));
    expect(error).toBeInstanceOf(TelegramError);
    expect(error).not.toBeInstanceOf(OutcomeUnknown);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("429 — повтор через retry_after", async () => {
    fetchMock
      .mockResolvedValueOnce(fail(429, { parameters: { retry_after: 3 } }))
      .mockResolvedValueOnce(ok());
    expect((await run(send("sendMessage", {}))).value).toEqual({ message_id: 77 });
  });

  it("5xx — повтор", async () => {
    fetchMock.mockResolvedValueOnce(fail(502)).mockResolvedValueOnce(ok());
    expect((await run(send("sendMessage", {}))).value).toEqual({ message_id: 77 });
  });

  it("4xx — явный отказ без повтора, со статусом", async () => {
    fetchMock.mockResolvedValue(fail(403));
    const { error } = await run(send("sendMessage", {}));
    expect(error).toBeInstanceOf(TelegramError);
    expect(error).not.toBeInstanceOf(OutcomeUnknown);
    expect(error.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("FormData уходит без JSON-заголовка", async () => {
    fetchMock.mockResolvedValue(ok());
    const form = new FormData();
    form.set("chat_id", "1");
    await run(send("sendDocument", form));
    const init = fetchMock.mock.calls[0][1];
    expect(init.body).toBe(form);
    expect(init.headers).toBeUndefined();
  });
});

function fakeStore(claim = { claimed: true, id: 5 }) {
  return {
    outboundClaim: vi.fn().mockResolvedValue(claim),
    outboundMarkSent: vi.fn(),
    outboundMarkUnknown: vi.fn(),
    outboundRelease: vi.fn(),
    draftLockForSending: vi.fn().mockResolvedValue(true),
    draftSetStatus: vi.fn(),
    draftDelete: vi.fn(),
  };
}
const message = { key: "pause:1:9:0", scope: "group", chatId: -1, method: "sendMessage", params: { text: "x" } };

describe("deliver: outbox", () => {
  it("свободный ключ: отправка и sent с tg_message_id", async () => {
    const store = fakeStore();
    const sendFn = vi.fn().mockResolvedValue({ message_id: 77 });
    expect(await deliver(message, { store, sendFn })).toEqual({ status: "sent", tgMessageId: 77 });
    expect(store.outboundMarkSent).toHaveBeenCalledWith(5, 77);
  });

  it("ключ уже sent: без отправки (упавшая задача только завершает)", async () => {
    const store = fakeStore({ claimed: false, status: "sent", tgMessageId: 77 });
    const sendFn = vi.fn();
    expect(await deliver(message, { store, sendFn })).toEqual({ status: "already_sent", tgMessageId: 77 });
    expect(sendFn).not.toHaveBeenCalled();
  });

  it("ключ pending у другой задачи: без отправки", async () => {
    const store = fakeStore({ claimed: false, status: "pending", tgMessageId: null });
    const sendFn = vi.fn();
    expect((await deliver(message, { store, sendFn })).status).toBe("in_flight");
    expect(sendFn).not.toHaveBeenCalled();
  });

  it("неизвестный исход: unknown, ключ остаётся занятым", async () => {
    const store = fakeStore();
    const sendFn = vi.fn().mockRejectedValue(new OutcomeUnknown("timeout"));
    expect((await deliver(message, { store, sendFn })).status).toBe("unknown");
    expect(store.outboundMarkUnknown).toHaveBeenCalledWith(5);
    expect(store.outboundRelease).not.toHaveBeenCalled();
  });

  it("точно не отправлено: ключ освобождается", async () => {
    const store = fakeStore();
    const sendFn = vi.fn().mockRejectedValue(new TelegramError("403"));
    expect((await deliver(message, { store, sendFn })).status).toBe("failed");
    expect(store.outboundRelease).toHaveBeenCalledWith(5);
  });
});

describe("publishDraft", () => {
  const draft = { draftId: 3, userId: 10, coupleId: 1, groupChatId: -100, params: { chat_id: -100, text: "✉ Иван" } };

  it("отправлен — черновик удаляется целиком", async () => {
    const store = fakeStore();
    const deliverFn = vi.fn().mockResolvedValue({ status: "sent" });
    expect(await publishDraft(draft, { store, deliver: deliverFn, notify: vi.fn() })).toBe("sent");
    expect(deliverFn.mock.calls[0][0].key).toBe("draft:3");
    expect(store.draftDelete).toHaveBeenCalledWith(3);
  });

  it("двойной клик: второй не проходит блокировку и ничего не шлёт", async () => {
    const store = fakeStore();
    store.draftLockForSending.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const deliverFn = vi.fn().mockResolvedValue({ status: "sent" });
    const [first, second] = await Promise.all([
      publishDraft(draft, { store, deliver: deliverFn, notify: vi.fn() }),
      publishDraft(draft, { store, deliver: deliverFn, notify: vi.fn() }),
    ]);
    expect([first, second].sort()).toEqual(["locked", "sent"]);
    expect(deliverFn).toHaveBeenCalledTimes(1);
  });

  it("неизвестный исход — статус unknown и «проверь группу» автору", async () => {
    const store = fakeStore();
    const notify = vi.fn();
    await publishDraft(draft, { store, deliver: vi.fn().mockResolvedValue({ status: "unknown" }), notify });
    expect(store.draftSetStatus).toHaveBeenCalledWith(3, "unknown");
    expect(notify).toHaveBeenCalledWith(10, UNKNOWN_DELIVERY_TEXT);
    expect(store.draftDelete).not.toHaveBeenCalled();
  });

  it("точно не отправлено — обратно в редактирование", async () => {
    const store = fakeStore();
    const notify = vi.fn();
    await publishDraft(draft, { store, deliver: vi.fn().mockResolvedValue({ status: "failed" }), notify });
    expect(store.draftSetStatus).toHaveBeenCalledWith(3, "editing");
    expect(notify).toHaveBeenCalledWith(10, FAILED_DELIVERY_TEXT);
  });
});
