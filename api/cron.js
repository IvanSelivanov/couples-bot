// Ежедневный cron Vercel (vercel.json → crons): обслуживание по сроку
// (дизайн-док «Хранение», R10, R18, R24, DR22, T19). Проверяет CRON_SECRET;
// каждый шаг изолирован — сбой одного не отменяет остальные. В ответ и лог
// — только счётчики, без текста.
//
//   1. чистка по срокам (лички > 6 дней всегда, служебные таблицы)
//   2. зависшие в фолбэке апдейты — дообработка (R10)
//   3. сворачивание личек после 48 ч тишины, затем удаление покрытого (DR22)
//   4. сворачивание общей истории по порогу (> 80 несвёрнутых или к сроку)
//   5. номера помощи: страны без кеша или старше 30 дней (T19)
//   6. перешифровка шифротекстов старой версии ключа (R18)
//
// Сворачивание — уровень квоты 70%: на исчерпанном уровне шаг
// останавливается, лички всё равно удаляются по сроку шагом 1 (R24).

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
