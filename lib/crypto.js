// Шифрование текста лички в приложении (раздел «Доступ администратора», R18, R27).
//
// Что это даёт и чего не даёт: шифротекст в Supabase не читается ни из
// дашборда, ни из бэкапа, ни при утечке service key. От автора проекта это
// не защищает — ключ лежит в переменных Vercel, которыми он управляет.
// Единственная настоящая мера против этого — хранить меньше (DR22, R24).
//
// Формат: v<версия>.<iv base64url>.<шифротекст+тег base64url>
// Версия ключа нужна для ротации: читаем текущим и предыдущим ключом,
// cron перешифровывает старую версию (needsReencrypt).
//
// aad (дополнительные аутентифицированные данные) привязывает шифротекст к
// месту хранения, например "dm:<user_id>": строку лички X нельзя тихо
// переставить в личку Y — расшифровка упадёт.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class CryptoError extends Error {}

function decodeKey(name) {
  const value = process.env[name];
  if (!value) return null;
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) throw new CryptoError(`${name}: нужен ключ 32 байта в base64`);
  return key;
}

function keys() {
  const current = decodeKey("DM_ENCRYPTION_KEY");
  if (!current) throw new CryptoError("DM_ENCRYPTION_KEY не задан");
  const version = Number(process.env.DM_ENCRYPTION_KEY_VERSION ?? 1);
  if (!Number.isInteger(version) || version < 1) throw new CryptoError("DM_ENCRYPTION_KEY_VERSION: целое ≥ 1");
  return { current, version, previous: decodeKey("DM_ENCRYPTION_KEY_PREV") };
}

export function encrypt(plaintext, aad = "") {
  const { current, version } = keys();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, current, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final(), cipher.getAuthTag()]);
  return `v${version}.${iv.toString("base64url")}.${body.toString("base64url")}`;
}

function parse(token) {
  const match = /^v(\d+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(String(token));
  if (!match) throw new CryptoError("не шифротекст этого формата");
  return { version: Number(match[1]), iv: Buffer.from(match[2], "base64url"), body: Buffer.from(match[3], "base64url") };
}

export function decrypt(token, aad = "") {
  const { current, version, previous } = keys();
  const parsed = parse(token);

  let key;
  if (parsed.version === version) key = current;
  else if (parsed.version === version - 1 && previous) key = previous;
  else throw new CryptoError(`нет ключа для версии v${parsed.version}`);

  if (parsed.iv.length !== IV_BYTES || parsed.body.length < TAG_BYTES) throw new CryptoError("повреждённый шифротекст");

  const tag = parsed.body.subarray(parsed.body.length - TAG_BYTES);
  const ciphertext = parsed.body.subarray(0, parsed.body.length - TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, key, parsed.iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    // Не различаем «не тот ключ», «не тот aad» и «подменили байты»: всё это
    // одна ситуация — доверять содержимому нельзя.
    throw new CryptoError("шифротекст не прошёл проверку подлинности");
  }
}

// true, если строку нужно перешифровать текущим ключом (cron после ротации).
export function needsReencrypt(token) {
  return parse(token).version !== keys().version;
}

// Помощник для генерации ключа: node -e "import('./lib/crypto.js').then(m=>console.log(m.generateKey()))"
export function generateKey() {
  return randomBytes(32).toString("base64");
}
