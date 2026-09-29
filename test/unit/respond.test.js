// T28: the helper's reply after a pause, every path (R12, R13, R20, R29, R31, DR14, DR23).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { coupleLangs, nextQuotaReset, respond } from "../../lib/session.js";
import { normalizePause, pausePrompt } from "../../lib/counsel.js";

const X = 1;
const Y = 2;
const context = (overrides = {}) => ({
  coupleId: 7,
  groupChatId: -100,
  autoTranslate: true,
  stateVersion: 3,
  abuseFlagActive: false,
  members: [
    { userId: X, lang: "ru", name: "Иван", tz: "Europe/Moscow" },
    { userId: Y, lang: "es", name: "María", tz: "Europe/Madrid" },
  ],
  summaries: { group: null },
  notes: [],
  shared: [
    { id: 10, author_user_id: X, is_bot: false, kind: "text", text: "Ты опять опоздала", tg_message_id: 501, addresses_bot: false },
    { id: 11, author_user_id: Y, is_bot: false, kind: "text", text: "Había tráfico", tg_message_id: 502, addresses_bot: false },
  ],
  ...overrides,
});

const pauseData = (overrides = {}) => ({
  translations: [
    { message_id: 10, lang: "es", text: "Otra vez llegaste tarde" },
    { message_id: 11, lang: "ru", text: "Были пробки" },
  ],
  safety: "none",
  speak: true,
  addressee_user_id: X,
  reply: [
    { lang: "ru", text: "Иван, что тебя задело больше всего?" },
    { lang: "es", text: "Iván, ¿qué te dolió más?" },
  ],
  escalation: false,
  ...overrides,
});

function harness({ generateResult, ctx = context(), canPublish = true, outboundStatus = null } = {}) {
  const store = {
    claimReplyWindow: vi.fn().mockResolvedValue("lease-1"),
    finishReply: vi.fn().mockResolvedValue({ ok: true, newerMessageId: null }),
    windowCouple: vi.fn().mockResolvedValue(7),
    outboundStatus: vi.fn().mockResolvedValue(outboundStatus),
    canPublish: vi.fn().mockResolvedValue(canPublish),
    markFirstReply: vi.fn().mockResolvedValue(),
  };
  const sent = [];
  const deps = {
    store,
    buildContext: vi.fn().mockResolvedValue(ctx),
    generate: vi.fn().mockResolvedValue(generateResult),
    deliver: vi.fn(async (message) => {
      sent.push(message);
      return { status: "sent", tgMessageId: 900 + sent.length };
    }),
    text: vi.fn(async (lang, key, params) => `${lang}:${key}${params?.reset ? `@${params.reset}` : ""}`),
    onSafety: vi.fn(),
    react: vi.fn(),
    scheduleTail: vi.fn(),
    now: () => Date.UTC(2026, 8, 28, 12, 0, 0),
  };
  return { store, deps, sent };
}

describe("respond", () => {
  it("аренда занята — ничего", async () => {
    const { store, deps } = harness();
    store.claimReplyWindow.mockResolvedValue(null);
    expect(await respond(1, 0, deps)).toEqual({ claimed: false });
    expect(deps.generate).not.toHaveBeenCalled();
  });

  it("speak: один вызов, ответ и переводы одним сообщением, маркер на последнюю реплику", async () => {
    const { store, deps, sent } = harness({ generateResult: { ok: true, data: pauseData() } });
    const r = await respond(1, 0, deps);
    expect(r).toMatchObject({ claimed: true, outcome: "spoke", published: 1 });
    expect(deps.generate).toHaveBeenCalledTimes(1);
    expect(deps.generate.mock.calls[0][0].purpose).toBe("pause");
    expect(sent).toHaveLength(1);
    expect(sent[0].key).toBe("pause:1:11:0");
    expect(sent[0].params.text).toContain("→ Иван · RU");
    expect(sent[0].params.text).toContain("Otra vez llegaste tarde");
    expect(store.markFirstReply).toHaveBeenCalledWith(1);
    expect(store.finishReply).toHaveBeenCalledWith(1, "lease-1", 11);
  });

  it("speak=false: только тихие переводы реплаями, итог окна не отмечается", async () => {
    const { store, deps, sent } = harness({ generateResult: { ok: true, data: pauseData({ speak: false, reply: [] }) } });
    expect((await respond(1, 0, deps)).outcome).toBe("silent");
    expect(sent.map((m) => m.params.reply_parameters.message_id)).toEqual([10, 11]);
    expect(sent.every((m) => m.params.disable_notification)).toBe(true);
    expect(store.markFirstReply).not.toHaveBeenCalled();
    expect(store.finishReply).toHaveBeenCalledWith(1, "lease-1", 11);
  });

  it("@бот: модель промолчала, но ответ всё равно есть (DR23)", async () => {
    const ctx = context();
    ctx.shared[1].addresses_bot = true;
    const { deps, sent } = harness({ generateResult: { ok: true, data: pauseData({ speak: false }) }, ctx });
    expect((await respond(1, 0, deps)).outcome).toBe("spoke");
    expect(sent).toHaveLength(1);
    expect(sent[0].params.text).toContain("Иван, что тебя задело больше всего?");
  });

  it("@бот, а текста ответа модель не дала — нейтральный фолбэк, не тишина", async () => {
    const ctx = context();
    ctx.shared[1].addresses_bot = true;
    const { deps, sent } = harness({ generateResult: { ok: true, data: pauseData({ speak: false, reply: [] }) }, ctx });
    await respond(1, 0, deps);
    expect(sent[0].params.text).toContain("fallback.neutral_block");
  });

  it("safety abuse — onSafety, обычный ответ не публикуется", async () => {
    const { deps, sent, store } = harness({ generateResult: { ok: true, data: pauseData({ safety: "abuse" }) } });
    expect((await respond(1, 0, deps)).outcome).toBe("abuse");
    expect(deps.onSafety).toHaveBeenCalledWith(expect.objectContaining({ signal: "abuse", surface: "group" }));
    expect(sent).toHaveLength(0);
    expect(store.finishReply).toHaveBeenCalledWith(1, "lease-1", 11);
  });

  it("блокировка фильтром crisis — onSafety", async () => {
    const { deps, sent } = harness({ generateResult: { blocked: "crisis" } });
    expect((await respond(1, 0, deps)).outcome).toBe("crisis");
    expect(deps.onSafety).toHaveBeenCalledWith(expect.objectContaining({ signal: "crisis" }));
    expect(sent).toHaveLength(0);
  });

  it("блокировка neutral — нейтральный фолбэк без кризисной ветки", async () => {
    const { deps, sent } = harness({ generateResult: { blocked: "neutral" } });
    expect((await respond(1, 0, deps)).outcome).toBe("neutral_block");
    expect(deps.onSafety).not.toHaveBeenCalled();
    expect(sent[0].params.text).toContain("fallback.neutral_block");
  });

  it("сбой модели — фолбэк с «Срочная помощь: /help», маркер всё равно сдвигается (DR14)", async () => {
    const { deps, sent, store } = harness({ generateResult: { unavailable: "error", reason: "parse" } });
    expect((await respond(1, 0, deps)).outcome).toBe("fallback");
    expect(sent[0].params.text).toContain("fallback.pause");
    expect(sent[0].params.text).toContain("fallback.urgent_help");
    expect(store.finishReply).toHaveBeenCalledWith(1, "lease-1", 11);
  });

  it("квота 90%: объявление с ключом на сутки, время сброса в поясе каждого, реакция 👀 (R31, DR5)", async () => {
    const { deps, sent } = harness({ generateResult: { unavailable: "quota", reason: "level" } });
    expect((await respond(1, 0, deps)).outcome).toBe("quota");
    expect(sent[0].key).toMatch(/^quota90:7:2026-09-28:0$/);
    expect(sent[0].params.disable_notification).toBe(true);
    expect(deps.text).toHaveBeenCalledWith("ru", "quota.level_90", expect.objectContaining({ reset: expect.any(String) }));
    expect(deps.react).toHaveBeenCalledWith(-100, 502);
  });

  it("пауза во время генерации — ответ молча выброшен (R12)", async () => {
    const { deps, sent, store } = harness({ generateResult: { ok: true, data: pauseData() }, canPublish: false });
    expect((await respond(1, 0, deps)).outcome).toBe("dropped");
    expect(sent).toHaveLength(0);
    expect(store.markFirstReply).not.toHaveBeenCalled();
  });

  it("упавшая задача уже отправила — без модели, только finish (R13)", async () => {
    const { deps, store } = harness({ outboundStatus: "sent" });
    expect((await respond(1, 0, deps)).outcome).toBe("already_published");
    expect(deps.generate).not.toHaveBeenCalled();
    expect(store.finishReply).toHaveBeenCalledWith(1, "lease-1", 11);
  });

  it("новых реплик нет — аренда снимается без вызова модели", async () => {
    const { deps } = harness({ ctx: context({ shared: [] }) });
    expect((await respond(1, 0, deps)).outcome).toBe("nothing");
    expect(deps.generate).not.toHaveBeenCalled();
  });

  it("хвост R11 — новая проверка", async () => {
    const { deps, store } = harness({ generateResult: { ok: true, data: pauseData() } });
    store.finishReply.mockResolvedValue({ ok: true, newerMessageId: 12 });
    await respond(1, 0, deps);
    expect(deps.scheduleTail).toHaveBeenCalledWith(1, 12);
  });
});

describe("normalizePause", () => {
  const input = { newMessageIds: [10, 11], coupleLangs: ["ru", "es"], addressedToBot: false };

  it("выбрасывает переводы чужих и старых id и голосовых", () => {
    const data = pauseData({
      translations: [
        { message_id: 10, lang: "es", text: "ok" },
        { message_id: 3, lang: "es", text: "старое" },
        { message_id: 11, lang: "ru", text: "голос" },
      ],
    });
    const r = normalizePause(data, { ...input, voiceMessageIds: [11] });
    expect(r.translations.map((t) => t.messageId)).toEqual([10]);
  });

  it("ответ только на языках пары", () => {
    const r = normalizePause(pauseData({ reply: [{ lang: "de", text: "x" }, { lang: "ru-RU", text: "да" }] }), input);
    expect(r.reply).toEqual([{ lang: "ru", text: "да" }]);
  });

  it("неизвестный safety становится none", () => {
    expect(normalizePause(pauseData({ safety: "weird" }), input).safety).toBe("none");
  });
});

describe("pausePrompt", () => {
  it("помечает новые реплики, обращения к боту и голосовые", () => {
    const ctx = context();
    ctx.shared.push({ id: 12, author_user_id: Y, is_bot: false, kind: "voice", text: null, transcript_status: "failed", addresses_bot: true });
    const prompt = pausePrompt(ctx, 10);
    expect(prompt).toContain("[11] María [NEW]: Había tráfico");
    expect(prompt).toContain("[12] María [NEW] [to bot] [voice]: (voice message, not transcribed)");
    expect(prompt).not.toContain("[10] Иван [NEW]");
  });
});

describe("вспомогательное", () => {
  it("языки пары: адресат первым, без повторов", () => {
    const members = [
      { userId: 1, lang: "ru" },
      { userId: 2, lang: "es-ES" },
    ];
    expect(coupleLangs(members, 2)).toEqual(["es", "ru"]);
    expect(coupleLangs([{ userId: 1, lang: "ru" }, { userId: 2, lang: "ru-RU" }])).toEqual(["ru"]);
  });

  it("сброс квоты — ближайшая полночь по PT", () => {
    const now = Date.UTC(2026, 8, 28, 12, 0, 0); // 05:00 PDT
    expect(new Date(nextQuotaReset(now)).toISOString()).toBe("2026-09-29T07:00:00.000Z");
  });
});

describe("объявления о лимите (DR5)", () => {
  it("переход на 70% — одно тихое объявление в сутки со временем сброса", async () => {
    const { deps, sent } = harness({ generateResult: { ok: true, usage: 0.72, data: pauseData() } });
    await respond(1, 0, deps);
    const notice = sent.find((m) => m.key.startsWith("quota70:"));
    expect(notice.key).toBe("quota70:7:2026-09-28:0");
    expect(notice.params.disable_notification).toBe(true);
    expect(deps.text).toHaveBeenCalledWith("es", "quota.level_70", expect.objectContaining({ reset: expect.any(String) }));
  });

  it("после дня на 90% — объявление о возврате функций", async () => {
    const { deps, sent, store } = harness({ generateResult: { ok: true, usage: 0.1, data: pauseData() } });
    store.outboundStatus.mockImplementation(async (key) => (key === "quota90:7:2026-09-27:0" ? "sent" : null));
    await respond(1, 0, deps);
    expect(sent.some((m) => m.key === "quotaok:7:2026-09-28:0")).toBe(true);
  });

  it("обычный день — без объявлений", async () => {
    const { deps, sent } = harness({ generateResult: { ok: true, usage: 0.1, data: pauseData() } });
    await respond(1, 0, deps);
    expect(sent.some((m) => /^quota/.test(m.key))).toBe(false);
  });
});
