#!/usr/bin/env node
// Vercel build step (vercel.json → buildCommand). This is what makes a
// one-click setup work without a terminal.
//
//   every build ─▶ check settings ─ problems ─▶ production: fail with a readable list; preview: warn
//   production  ─▶ apply database migrations (supabase db push)
//               ─▶ point Telegram at the production URL (webhook + commands)
//   preview     ─▶ nothing else: previews must not touch the live database or webhook
//
// The build log is often the only place a non-programmer looks, so every
// failure says which setting to fix and where.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { keyFromSecret } from "../lib/crypto.js";
import { configureTelegram } from "./telegram-setup.js";

const SETTINGS_HINT = "Vercel → your project → Settings → Environment Variables";

/** Problems with the settings, as sentences a person can act on. Empty = all good. */
export function checkSettings(env = process.env) {
  const problems = [];
  const need = (name, what) => {
    if (!env[name]?.trim()) problems.push(`${name} is empty: ${what}`);
  };
  need("BOT_TOKEN", "the token @BotFather gave you");
  need("GEMINI_API_KEY", "a key from https://aistudio.google.com/api-keys");
  need("ADMIN_NAME", "your name, shown to both partners in the consent text");
  need("DM_ENCRYPTION_KEY", "a passphrase of at least 16 characters that encrypts private chats");
  if (env.BOT_TOKEN && !/^\d+:[\w-]{20,}$/.test(env.BOT_TOKEN.trim())) {
    problems.push("BOT_TOKEN doesn't look like a bot token (it should look like 123456789:AAH...)");
  }
  if (env.DM_ENCRYPTION_KEY) {
    try {
      keyFromSecret(env.DM_ENCRYPTION_KEY);
    } catch {
      problems.push("DM_ENCRYPTION_KEY is too short: use a passphrase of at least 16 characters");
    }
  }
  if (!(env.SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL)) {
    problems.push("SUPABASE_URL is missing: connect Supabase in Vercel → your project → Storage");
  }
  if (!(env.SUPABASE_SERVICE_KEY ?? env.SUPABASE_SECRET_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY)) {
    problems.push("the Supabase key is missing: connect Supabase in Vercel → your project → Storage");
  }
  return problems;
}

// Direct connection string for migrations: SUPABASE_DB_URL for a manual setup,
// POSTGRES_URL_NON_POOLING from the Supabase integration.
export function migrationDbUrl(env = process.env) {
  return env.SUPABASE_DB_URL ?? env.POSTGRES_URL_NON_POOLING ?? null;
}

function migrate(dbUrl) {
  console.log("Applying database migrations…");
  // The URL holds the database password: it goes to the CLI only, never to the log.
  const r = spawnSync("npx", ["supabase", "db", "push", "--db-url", dbUrl, "--yes"], { stdio: "inherit" });
  if (r.status !== 0) throw new Error("database migrations failed (see the lines above)");
}

// Vercel wants an output directory even for a functions-only project.
function prepareOutput() {
  mkdirSync("public", { recursive: true });
  writeFileSync("public/index.html", "<!doctype html><title>couples-bot</title><p>This is a Telegram bot. Open it in Telegram.</p>\n");
}

export async function build(env = process.env, { migrateFn = migrate, configureFn = configureTelegram, prepareFn = prepareOutput } = {}) {
  const production = env.VERCEL_ENV === "production";
  const problems = checkSettings(env);
  if (problems.length) {
    const message = `Settings need fixing (${SETTINGS_HINT}), then redeploy:\n  - ${problems.join("\n  - ")}`;
    // A preview often has no variables of its own; only production must be complete.
    if (production) throw new Error(message);
    console.warn(message);
  }

  prepareFn();

  if (!production) {
    console.log(`Build for ${env.VERCEL_ENV ?? "local"}: skipping migrations and Telegram setup (production only).`);
    return { migrated: false, telegram: false };
  }

  const dbUrl = migrationDbUrl(env);
  if (dbUrl) migrateFn(dbUrl);
  else console.warn("No SUPABASE_DB_URL or POSTGRES_URL_NON_POOLING: skipping migrations. Apply them with `npx supabase db push`.");

  const host = env.VERCEL_PROJECT_PRODUCTION_URL;
  if (!host) throw new Error("VERCEL_PROJECT_PRODUCTION_URL is missing: enable system environment variables in the project settings");
  await configureFn(`https://${host}`);
  return { migrated: Boolean(dbUrl), telegram: true };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await build();
  } catch (error) {
    console.error(`\n✖ ${error.message}\n`);
    process.exit(1);
  }
}
