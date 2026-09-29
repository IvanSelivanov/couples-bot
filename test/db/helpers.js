// Direct SQL to the local database, only for preparing and checking state in
// tests. The bot itself talks to the database through PostgREST (lib/db.js).
import postgres from "postgres";
import { inject } from "vitest";

// lib/db.js reads its config from the environment, as in production.
export function useLocalSupabase() {
  process.env.SUPABASE_URL = inject("apiUrl");
  process.env.SUPABASE_SERVICE_KEY = inject("serviceKey");
}

export async function createCouple(sql, { state = "active" } = {}) {
  const [couple] = await sql`
    insert into couples (group_chat_id, state) values (${-Math.floor(Math.random() * 1e12)}, ${state})
    returning id, state_version
  `;
  const [window] = await sql`insert into windows (couple_id) values (${couple.id}) returning id`;
  return { coupleId: couple.id, stateVersion: couple.state_version, windowId: window.id };
}

export async function addPartnerMessage(sql, coupleId, { author = 1, scope = "group" } = {}) {
  const [row] = await sql`
    insert into messages (couple_id, scope, author_user_id, tg_chat_id, tg_message_id, text)
    values (${coupleId}, ${scope}, ${author}, -1, ${Math.floor(Math.random() * 1e12)}, 'x')
    returning id
  `;
  return row.id;
}

export function connect() {
  return postgres(inject("dbUrl"), { max: 4, onnotice: () => {} });
}

// Truncates every table in the public schema except those passed in keep.
export async function truncateAll(sql, keep = []) {
  const rows = await sql`
    select tablename from pg_tables where schemaname = 'public'
  `;
  const tables = rows.map((r) => r.tablename).filter((t) => !keep.includes(t));
  if (tables.length === 0) return;
  await sql.unsafe(`truncate ${tables.map((t) => `"${t}"`).join(", ")} restart identity cascade`);
}
