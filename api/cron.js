// Daily Vercel cron (vercel.json → crons): time-based maintenance
// (design doc "Retention", R10, R18, R24, DR22, T19). Checks CRON_SECRET;
// each step is isolated, so one failing doesn't cancel the others. The
// response and logs contain only counters, never text.
//
//   1. retention cleanup (private chats older than 6 days always, service tables)
//   2. updates stuck in the fallback path: finish processing them (R10)
//   3. fold private chats after 48 h of silence, then delete what's covered (DR22)
//   4. fold the shared history by threshold (> 80 unfolded, or when due)
//   5. help-line numbers: countries without a cache or older than 30 days (T19)
//   6. re-encrypt ciphertexts made with an old key version (R18)
//
// Folding runs at the 70% quota tier: when that tier is exhausted the step
// stops, and private chats are still deleted on schedule by step 1 (R24).

import * as db from "../lib/db.js";
import { foldDm, foldGroup, reencryptBatch } from "../lib/context.js";
import { openUpdate, processUpdate } from "../lib/ingest.js";
import { refreshHelpLines } from "../lib/safety.js";
import { handleUpdate } from "../lib/handle.js";
import { vercelEnv } from "../lib/queue.js";

const MAX_FOLDS_PER_RUN = 10;
const HELP_LINES_MAX_AGE_DAYS = 30;

async function step(name, report, work) {
  try {
    report[name] = await work();
  } catch (error) {
    report[name] = { error: `${error.name}: ${error.message}`.slice(0, 200) };
  }
}

async function foldAll(candidates, fold) {
  let folded = 0;
  for (const candidate of candidates.slice(0, MAX_FOLDS_PER_RUN)) {
    const r = await fold(candidate);
    if (r.folded) folded++;
    else if (r.reason === "quota") return { folded, stopped: "quota" };
  }
  return { folded, pending: Math.max(0, candidates.length - MAX_FOLDS_PER_RUN) };
}

/**
 * @param {object} deps { store, handle, foldDmFn, foldGroupFn, refreshFn, reencryptFn }
 */
export async function runMaintenance(deps = {}) {
  const store = deps.store ?? db;
  const report = {};

  await step("purge", report, () => store.cronPurge());

  await step("stuck_updates", report, async () => {
    const stuck = await store.stuckUpdates();
    let done = 0;
    for (const row of stuck) {
      const update = openUpdate(Number(row.update_id), row.payload);
      await processUpdate(update, { handle: deps.handle, store });
      done++;
    }
    return { done };
  });

  await step("fold_dm", report, async () =>
    foldAll(await store.dmFoldCandidates(), (c) => (deps.foldDmFn ?? foldDm)(c.coupleId, c.ownerUserId)),
  );
  await step("fold_group", report, async () =>
    foldAll(await store.groupFoldCandidates(), (coupleId) => (deps.foldGroupFn ?? foldGroup)(coupleId)),
  );

  await step("help_lines", report, async () => {
    const stale = new Set(await store.helpLinesStale(HELP_LINES_MAX_AGE_DAYS));
    const inUse = await store.countriesInUse();
    const cached = new Set((await store.helpLinesGet(inUse)).map((r) => r.country));
    for (const country of inUse) if (!cached.has(country)) stale.add(country);
    let refreshed = 0;
    for (const country of stale) {
      await (deps.refreshFn ?? refreshHelpLines)(country);
      refreshed++;
    }
    return { refreshed };
  });

  await step("reencrypt", report, async () => ({ rewritten: await (deps.reencryptFn ?? reencryptBatch)() }));

  return report;
}

export default async function handler(request, response) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.authorization !== `Bearer ${secret}`) {
    response.status(403).json({ ok: false });
    return;
  }
  const report = await runMaintenance({ handle: (update) => handleUpdate(update, vercelEnv()) });
  console.log("[cron]", JSON.stringify(report));
  response.status(200).json({ ok: true, report });
}
