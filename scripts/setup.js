#!/usr/bin/env node
// Manual bot setup after deploying from the command line (DR16, R10):
//   npm run setup https://<project>.vercel.app
// A deploy through Vercel's Git integration or Deploy button does this in the
// build (scripts/vercel-build.js), so this is only needed for manual deploys.

import { configureTelegram } from "./telegram-setup.js";

const base = process.argv[2];
if (!base?.startsWith("https://")) {
  console.error("Pass the deployment URL: npm run setup https://<project>.vercel.app");
  process.exit(1);
}
await configureTelegram(base);
