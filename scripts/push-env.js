#!/usr/bin/env node
// Pushes environment variables to Vercel production: secrets from .env, the
// Supabase URL and key from .env.production (prod differs from local Docker).
//
//   npm run push-env
//
// Values go to vercel through stdin, not as arguments, so they don't show up
// in the process list or in output. The script prints names only.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const KEYS = [
  "BOT_TOKEN",
  "BOT_USERNAME",
  "WEBHOOK_SECRET",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_KEY",
  "GEMINI_API_KEY",
  "GEMINI_DAILY_LIMIT",
  "GEMINI_MODEL",
  "DM_ENCRYPTION_KEY",
  "DM_ENCRYPTION_KEY_VERSION",
  "DM_ENCRYPTION_KEY_PREV",
  "CRON_SECRET",
  "ADMIN_NAME",
];
const OPTIONAL = new Set(["DM_ENCRYPTION_KEY_PREV", "GEMINI_MODEL"]);
const FROM_PRODUCTION = new Set(["SUPABASE_URL", "SUPABASE_SERVICE_KEY"]);

function parseEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
  return out;
}

const local = parseEnvFile(".env");
const production = parseEnvFile(".env.production");

const values = {};
const missing = [];
for (const key of KEYS) {
  const value = FROM_PRODUCTION.has(key) ? production[key] : local[key];
  if (value) values[key] = value;
  else if (!OPTIONAL.has(key)) missing.push(`${key} (${FROM_PRODUCTION.has(key) ? ".env.production" : ".env"})`);
}
if (missing.length) {
  console.error(`Not filled in: ${missing.join(", ")}`);
  process.exit(1);
}
if (/localhost|127\.0\.0\.1/.test(values.SUPABASE_URL)) {
  console.error("SUPABASE_URL in .env.production points to the local Supabase.");
  process.exit(1);
}

for (const [key, value] of Object.entries(values)) {
  // npx: works without a global Vercel CLI install.
  const r = spawnSync("npx", ["--yes", "vercel", "env", "add", key, "production", "--force", "--sensitive"], {
    input: value,
    stdio: ["pipe", "ignore", "pipe"],
    shell: process.platform === "win32",
  });
  if (r.status !== 0) {
    console.error(`${key}: failed\n${r.stderr.toString().trim()}`);
    process.exit(1);
  }
  console.log(`${key}: ok`);
}
