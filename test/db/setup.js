// globalSetup для db-набора: находит локальный Supabase и накатывает миграции
// с нуля. Базу поднимает человек (`npm run db:start`), а не тест: старт
// контейнеров занимает минуты и не должен прятаться внутри `npm run test:db`.
import { execFileSync } from "node:child_process";

function supabase(...args) {
  return execFileSync("npx", ["supabase", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// После db reset PostgREST перезапускается и какое-то время отвечает 503 или
// со старым кешем схемы. Ждём, пока он увидит наши функции.
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
      // PostgREST ещё не слушает порт
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

  // Каждый прогон начинается с чистой схемы из supabase/migrations: так тесты
  // проверяют ровно то, что уедет в прод, а не накопленное состояние.
  supabase("db", "reset", "--local");
  await waitForRest(status.REST_URL, status.SERVICE_ROLE_KEY);

  provide("dbUrl", status.DB_URL);
  provide("apiUrl", status.API_URL);
  provide("restUrl", status.REST_URL);
  provide("serviceKey", status.SERVICE_ROLE_KEY);
  provide("anonKey", status.ANON_KEY);
}
