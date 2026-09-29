// Guest Mode: which chat counts as the couple's 1:1 chat (DR12). The guest_message shape
// comes from the 2026-09-29 spike, with ids replaced.
import { describe, expect, it } from "vitest";
import { isCoupleChat } from "../../lib/handle.js";

const X = 1;
const Y = 2;
const STRANGER = 3;
const couple = { members: [{ userId: X }, { userId: Y }] };

function guestMessage({ chatId, chatType = "private", from = X, replyFrom = Y }) {
  return {
    message_id: 10,
    from: { id: from },
    chat: { id: chatId, type: chatType },
    reply_to_message: { message_id: 9, from: { id: replyFrom }, text: "Ты уже дома?" },
    guest_query_id: "q1",
    text: "@couple_psych_bot что он имел в виду?",
  };
}

describe("isCoupleChat", () => {
  it("личка с партнёром: chat.id равен партнёру вызвавшего", () => {
    expect(isCoupleChat(guestMessage({ chatId: Y }), couple, X)).toBe(true);
    expect(isCoupleChat(guestMessage({ chatId: X, from: Y, replyFrom: X }), couple, Y)).toBe(true);
  });

  it("личка с третьим человеком — не пара", () => {
    expect(isCoupleChat(guestMessage({ chatId: STRANGER, replyFrom: STRANGER }), couple, X)).toBe(false);
  });

  it("группа — не личка пары, даже если в ней оба", () => {
    expect(isCoupleChat(guestMessage({ chatId: -100500, chatType: "supergroup" }), couple, X)).toBe(false);
  });

  it("пара из одного участника — не подтверждена", () => {
    expect(isCoupleChat(guestMessage({ chatId: Y }), { members: [{ userId: X }] }, X)).toBe(false);
  });
});
