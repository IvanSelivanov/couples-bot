// T10: редьюсер /check (дизайн-док «/check», R14, R16, DR6).
import { describe, expect, it } from "vitest";
import { CHECK_TIMEOUT_MS, checkReducer, decide, shouldOfferCheck } from "../../lib/session.js";

const SPEAKER = 1;
const LISTENER = 2;
const base = {
  speaker_user_id: SPEAKER,
  listener_user_id: LISTENER,
  state: "awaiting_paraphrase",
  round: 1,
  prompt_message_id: 500,
  hinted: false,
  updated_at: new Date(0).toISOString(),
};
const at = (patch) => ({ ...base, ...patch });
const keys = (effects) => effects.map((e) => e.key ?? e.type);

describe("пересказ слушающего", () => {
  it("реплай на подсказку — показать пересказ говорящему с кнопками вердикта", () => {
    const r = checkReducer(base, { type: "message", userId: LISTENER, replyToMessageId: 500, messageId: 9 });
    expect(r.next).toEqual({ state: "awaiting_verdict" });
    expect(r.effects).toContainEqual({ type: "show_paraphrase", messageId: 9, text: null, to: SPEAKER });
    expect(keys(r.effects)).toContain("remove_buttons");
  });

  it("не реплай — одна подсказка «ответь реплаем», вторая — тишина", () => {
    const first = checkReducer(base, { type: "message", userId: LISTENER, replyToMessageId: null, messageId: 9 });
    expect(first.next).toEqual({ hinted: true });
    expect(keys(first.effects)).toEqual(["check.reply_hint"]);
    const second = checkReducer(at({ hinted: true }), { type: "message", userId: LISTENER, messageId: 10 });
    expect(second).toEqual({ next: null, effects: [] });
  });

  it("реплика говорящего во время ожидания пересказа ничего не меняет", () => {
    expect(checkReducer(base, { type: "message", userId: SPEAKER, replyToMessageId: 500 })).toEqual({ next: null, effects: [] });
  });
});

describe("вердикт говорящего", () => {
  const waiting = at({ state: "awaiting_verdict" });

  it("«Меня поняли верно» — успех, без оценок", () => {
    const r = checkReducer(waiting, { type: "verdict", userId: SPEAKER, understood: true });
    expect(r.next).toEqual({ ended: true, outcome: "understood" });
    expect(keys(r.effects)).toEqual(["remove_buttons", "check.success"]);
  });

  it("«Уточнить смысл» в первом раунде — говорящий уточняет", () => {
    const r = checkReducer(waiting, { type: "verdict", userId: SPEAKER, understood: false });
    expect(r.next).toEqual({ state: "clarifying" });
    expect(keys(r.effects)).toContain("check.clarify");
  });

  it("второе «Уточнить смысл» — «есть что обсудить подробнее», конец", () => {
    const r = checkReducer(at({ state: "awaiting_verdict", round: 2 }), { type: "verdict", userId: SPEAKER, understood: false });
    expect(r.next).toEqual({ ended: true, outcome: "discuss_more" });
    expect(keys(r.effects)).toContain("check.discuss_more");
  });

  it("уточнение говорящего запускает второй раунд пересказа", () => {
    const r = checkReducer(at({ state: "clarifying" }), { type: "message", userId: SPEAKER, messageId: 77 });
    expect(r.next).toEqual({ state: "awaiting_paraphrase", round: 2, hinted: false, prompt_message_id: null });
    expect(r.effects).toEqual([{ type: "ask_paraphrase", to: LISTENER, blockMessageId: 77, round: 2 }]);
  });
});

describe("кнопки (DR6.6, DR17)", () => {
  it("чужое нажатие вердикта — «Эта кнопка для <имя>»", () => {
    const r = checkReducer(at({ state: "awaiting_verdict" }), { type: "verdict", userId: LISTENER, understood: true });
    expect(r).toEqual({ next: null, effects: [{ type: "popup", key: "button.not_yours", userId: SPEAKER }] });
  });

  it("чужое «Пропустить»", () => {
    const r = checkReducer(base, { type: "skip", userId: SPEAKER });
    expect(r.effects).toEqual([{ type: "popup", key: "button.not_yours", userId: LISTENER }]);
  });

  it("устаревшая кнопка — «Это уже неактуально»", () => {
    expect(checkReducer(base, { type: "verdict", userId: SPEAKER, understood: true }).effects).toEqual([
      { type: "popup", key: "button.stale" },
    ]);
  });

  it("«Пропустить» у слушающего всегда доступно и заканчивает упражнение (R14)", () => {
    const r = checkReducer(base, { type: "skip", userId: LISTENER });
    expect(r.next).toEqual({ ended: true, outcome: "skipped" });
    expect(keys(r.effects)).toContain("check.skipped");
  });
});

describe("таймаут и отмена", () => {
  it("10 минут без движения — ленивое закрытие", () => {
    const now = new Date(base.updated_at).getTime() + CHECK_TIMEOUT_MS + 1;
    expect(checkReducer(base, { type: "tick", now }).next).toEqual({ ended: true, outcome: "timeout" });
  });

  it("до 10 минут — ничего", () => {
    const now = new Date(base.updated_at).getTime() + CHECK_TIMEOUT_MS - 1;
    expect(checkReducer(base, { type: "tick", now })).toEqual({ next: null, effects: [] });
  });

  it("/cancel от участника упражнения", () => {
    expect(checkReducer(base, { type: "cancel", userId: SPEAKER }).next).toEqual({ ended: true, outcome: "cancelled" });
  });

  it("/cancel от постороннего игнорируется", () => {
    expect(checkReducer(base, { type: "cancel", userId: 99 }).next).toBeNull();
  });
});

describe("эскалация и дебаунс (R16)", () => {
  it("escalation — повод предложить", () => {
    expect(shouldOfferCheck({ escalation: true, abuseFlagActive: false, checkActive: false })).toBe(true);
  });

  it("при активном флаге бот сам не предлагает", () => {
    expect(shouldOfferCheck({ escalation: true, abuseFlagActive: true, checkActive: false })).toBe(false);
  });

  it("без escalation и при идущем /check не предлагает", () => {
    expect(shouldOfferCheck({ escalation: false, abuseFlagActive: false, checkActive: false })).toBe(false);
    expect(shouldOfferCheck({ escalation: true, abuseFlagActive: false, checkActive: true })).toBe(false);
  });

  it("пока /check активен, ведущий по дебаунсу не отвечает", () => {
    expect(decide({ answeredUpTo: 0, latestId: 3, checkActive: true }, { kind: "debounce", messageId: 3 })).toBe("check_active");
  });
});
