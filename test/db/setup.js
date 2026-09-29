// globalSetup for the db suite: finds the local Supabase and applies migrations
// from scratch. A person starts the database (`npm run db:start`), not the test:
// starting containers takes minutes and shouldn't hide inside `npm run test:db`.
import { execFileSync } from "node:child_process";

function supabase(...args) {
  return execFileSync("npx", ["supabase", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// After db reset PostgREST restarts and for a while answers 503 or serves a stale
// schema cache. Wait until it sees our functions.
async function waitForRest(restUrl, key) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const response = await fetch(`${restUrl}/rpc/can_publish`, {
        method: "POST",
        headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ p_window_id: 0, p_lease_id: "00000000-0000-0000-0000-000000000000", p_state_version: 0 }),
      });
      if (response.ok) return;
    } catch {
      // PostgREST isn't listening on the port yet
    }
    if (Date.now() > deadline) throw new Error("PostgREST не поднялся за 60 с после db reset");
    await new Promise((r) => setTimeout(r, 500));
  }
}

export default async function setup({ provide }) {
  let status;
  try {
    status = JSON.parse(supabase("status", "-o", "json"));
  } catch {
    throw new Error("Локальный Supabase не запущен. Сначала: npm run db:start");
  }

  // Every run starts from a clean schema built from supabase/migrations, so the tests
  // check exactly what ships to production, not accumulated state.
  supabase("db", "reset", "--local");
  await waitForRest(status.REST_URL, status.SERVICE_ROLE_KEY);

  provide("dbUrl", status.DB_URL);
  provide("apiUrl", status.API_URL);
  provide("restUrl", status.REST_URL);
  provide("serviceKey", status.SERVICE_ROLE_KEY);
  provide("anonKey", status.ANON_KEY);
}
