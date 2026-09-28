// T12: шифрование лички и ротация ключа (R18).
import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { CryptoError, decrypt, encrypt, needsReencrypt } from "../../lib/crypto.js";

const keyA = randomBytes(32).toString("base64");
const keyB = randomBytes(32).toString("base64");

function useKeys({ current, version = 1, previous } = {}) {
  process.env.DM_ENCRYPTION_KEY = current ?? keyA;
  process.env.DM_ENCRYPTION_KEY_VERSION = String(version);
  if (previous) process.env.DM_ENCRYPTION_KEY_PREV = previous;
  else delete process.env.DM_ENCRYPTION_KEY_PREV;
}

beforeEach(() => useKeys());

describe("encrypt / decrypt", () => {
  it("круговой путь, включая кириллицу и эмодзи", () => {
    const text = "Мне было обидно 😔 — и я не сказала";
    expect(decrypt(encrypt(text, "dm:1"), "dm:1")).toBe(text);
  });

  it("одинаковый текст даёт разные шифротексты (случайный iv)", () => {
    expect(encrypt("да")).not.toBe(encrypt("да"));
  });

  it("шифротекст не содержит открытого текста", () => {
    expect(encrypt("секрет")).not.toMatch(/секрет/);
  });

  it("чужой aad не расшифровывает: строку лички X нельзя переставить к Y", () => {
    const token = encrypt("личное", "dm:1");
    expect(() => decrypt(token, "dm:2")).toThrow(CryptoError);
  });

  it("подменённый байт отклоняется", () => {
    const token = encrypt("личное");
    const [v, iv, body] = token.split(".");
    const bytes = Buffer.from(body, "base64url");
    bytes[0] ^= 1;
    expect(() => decrypt(`${v}.${iv}.${bytes.toString("base64url")}`)).toThrow(/подлинности/);
  });

  it("мусор вместо шифротекста — понятная ошибка", () => {
    expect(() => decrypt("просто текст")).toThrow(/формата/);
  });

  it("ключ не той длины отклоняется", () => {
    process.env.DM_ENCRYPTION_KEY = randomBytes(16).toString("base64");
    expect(() => encrypt("x")).toThrow(/32 байта/);
  });

  it("без ключа — ошибка, а не открытый текст", () => {
    delete process.env.DM_ENCRYPTION_KEY;
    expect(() => encrypt("x")).toThrow(/не задан/);
  });
});

describe("ротация ключа", () => {
  it("после ротации старые строки читаются предыдущим ключом и помечаются на перешифровку", () => {
    const old = encrypt("старое", "dm:1");
    useKeys({ current: keyB, version: 2, previous: keyA });
    expect(decrypt(old, "dm:1")).toBe("старое");
    expect(needsReencrypt(old)).toBe(true);

    const fresh = encrypt(decrypt(old, "dm:1"), "dm:1");
    expect(fresh.startsWith("v2.")).toBe(true);
    expect(needsReencrypt(fresh)).toBe(false);
  });

  it("без предыдущего ключа старая версия не читается", () => {
    const old = encrypt("старое");
    useKeys({ current: keyB, version: 2 });
    expect(() => decrypt(old)).toThrow(/нет ключа для версии v1/);
  });

  it("версия через одну не читается", () => {
    const old = encrypt("старое");
    useKeys({ current: keyB, version: 3, previous: keyA });
    expect(() => decrypt(old)).toThrow(/v1/);
  });
});
