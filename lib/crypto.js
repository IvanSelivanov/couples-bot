// In-app encryption of private chat text (section "Admin access", R18, R27).
//
// What it does and doesn't give: ciphertext in Supabase can't be read from the
// dashboard, from a backup, or with a leaked service key. It does not protect
// against the person running the bot: the key lives in Vercel variables they control.
// The only real measure against that is storing less (DR22, R24).
//
// Format: v<version>.<iv base64url>.<ciphertext+tag base64url>
// The key version enables rotation: we read with the current and previous key,
// and cron re-encrypts the old version (needsReencrypt).
//
// aad (additional authenticated data) binds the ciphertext to where it is
// stored, e.g. "dm:<user_id>": a row from X's private chat can't be silently
// moved into Y's; decryption would fail.
//
// DM_ENCRYPTION_KEY is either a raw key (32 bytes in base64, 44 characters) or a
// passphrase of at least 16 characters. A passphrase is stretched into a key with
// scrypt, so people setting the bot up from a browser don't need a terminal to
// generate a key. The same passphrase always gives the same key.

import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class CryptoError extends Error {}

const MIN_PASSPHRASE = 16;
const PASSPHRASE_SALT = "couples-bot:dm-encryption-key:v1";
const derived = new Map(); // scrypt is deliberately slow: derive once per process

export function keyFromSecret(value, name = "DM_ENCRYPTION_KEY") {
  if (/^[A-Za-z0-9+/]{43}=$/.test(value)) return Buffer.from(value, "base64");
  if (value.length < MIN_PASSPHRASE) {
    throw new CryptoError(`${name}: нужен ключ 32 байта в base64 или фраза-пароль от ${MIN_PASSPHRASE} символов`);
  }
  if (!derived.has(value)) derived.set(value, scryptSync(value, PASSPHRASE_SALT, 32, { N: 2 ** 15, maxmem: 64 * 1024 * 1024 }));
  return derived.get(value);
}

function decodeKey(name) {
  const value = process.env[name];
  if (!value) return null;
  return keyFromSecret(value, name);
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
    // We don't distinguish "wrong key", "wrong aad" and "tampered bytes": they are
    // the same situation, the content can't be trusted.
    throw new CryptoError("шифротекст не прошёл проверку подлинности");
  }
}

// true if the string must be re-encrypted with the current key (cron after rotation).
export function needsReencrypt(token) {
  return parse(token).version !== keys().version;
}

// Webhook secret (setWebhook secret_token; also signs invite links). WEBHOOK_SECRET
// if set; otherwise derived from the bot token, so a one-click setup needs one
// secret fewer. Anyone who has the token controls the bot anyway.
export function webhookSecret() {
  if (process.env.WEBHOOK_SECRET) return process.env.WEBHOOK_SECRET;
  const token = process.env.BOT_TOKEN;
  if (!token) throw new CryptoError("нет ни WEBHOOK_SECRET, ни BOT_TOKEN");
  return createHmac("sha256", token).update("couples-bot:webhook").digest("hex");
}

// Key generation helper: node -e "import('./lib/crypto.js').then(m=>console.log(m.generateKey()))"
export function generateKey() {
  return randomBytes(32).toString("base64");
}
