// Сводки, итог окна и cron на живой базе (DR9, DR22, DR23, R10, R18, R24, R30).
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { foldDm, foldGroup, recapAndFold } from "../../lib/context.js";
import { recapWindow } from "../../lib/session.js";
import { decrypt, encrypt } from "../../lib/crypto.js";
import { sealUpdate } from "../../lib/ingest.js";
import { runMaintenance } from "../../api/cron.js";
import { connect, truncateAll, useLocalSupabase } from "./helpers.js";

const sql = connect();
const keyA = randomBytes(32).toString("base64");
const keyB = randomBytes(32).toString("base64");
beforeAll(useLocalSupabase);
afterAll(() => sql.end());

const X = 1;
const Y = 2;
let coupleId;

beforeEach(async () => {
  process.env.DM_ENCRYPTION_KEY = keyA;
  process.env.DM_ENCRYPTION_KEY_VERSION = "1";
  delete process.env.DM_ENCRYPTION_KEY_PREV;
  await truncateAll(sql);
  const [c] = await sql`insert into couples (group_chat_id, state) values (-6060, 'active') returning id`;
  coupleId = c.id;
  await sql`insert into members (user_id, couple_id, lang, display_name) values (${X}, ${coupleId}, 'ru', 'Иван'), (${Y}, ${coupleId}, 'es', 'María')`;
});

const summaryOk = (summary = "SUMMARY") => vi.fn().mockResolvedValue({ ok: true, data: { summary } });

async function windowWith(texts, { firstReply = true } = {}) {
  const [w] = await sql`
    insert into windows (couple_id, started_at, ended_at, first_reply_at)
    values (${coupleId}, now() - interval '1 hour', now() - interval '31 minutes', ${firstReply ? sql`now() - interval '50 minutes'` : null})
    returning id`;
  for (const t of texts) {
    await sql`insert into messages (couple_id, scope, author_user_id, text, created_at) values (${coupleId}, 'group', ${X}, ${t}, now() - interval '45 minutes')`;
  }
  return w.id;
}

describe("итог окна (DR9, DR23, R30)", () => {
  it("окно с ответом ведущего: один вызов даёт итог и сводку", async () => {
    const w = await windowWith(["а", "б"]);
    const generateFn = vi.fn().mockResolvedValue({ ok: true, data: { summary: "S", recap: [{ lang: "ru", text: "Уточнили A; открыто B" }] } });
    const r = await recapAndFold(w, ["ru", "es"], { generateFn });
    expect(r.recap).toEqual([{ lang: "ru", text: "Уточнили A; открыто B" }]);
    expect(generateFn.mock.calls[0][0].purpose).toBe("recap");
    const [s] = await sql`select text from summaries where scope_key = 'group'`;
    expect(s.text).toBe("S");
  });

  it("бытовое окно без ответа ведущего — молча, без вызова", async () => {
    const w = await windowWith(["купи хлеб"], { firstReply: false });
    const generateFn = vi.fn();
    expect(await recapAndFold(w, ["ru"], { generateFn })).toEqual({ recap: null, reason: "silent_window" });
    expect(generateFn).not.toHaveBeenCalled();
  });

  it("опоздавший итог отбрасывается, если новое окно уже ответило (R30)", async () => {
    const w = await windowWith(["а"]);
    const [fresh] = await sql`insert into windows (couple_id, first_reply_at) values (${coupleId}, now()) returning id`;
    const deliver = vi.fn();
    const couple = { id: coupleId, groupChatId: -6060, members: [{ userId: X, lang: "ru" }, { userId: Y, lang: "es" }] };
    const r = await recapWindow(
      { closedWindowId: w, newWindowId: fresh.id, couple },
      { deliver, recapAndFold: async () => ({ recap: [{ lang: "ru", text: "итог" }] }) },
    );
    expect(r).toEqual({ published: false, reason: "late" });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("итог вовремя — тихое двуязычное сообщение с ключом по окну", async () => {
    const w = await windowWith(["а"]);
    const [fresh] = await sql`insert into windows (couple_id) values (${coupleId}) returning id`;
    const deliver = vi.fn().mockResolvedValue({ status: "sent" });
    const couple = { id: coupleId, groupChatId: -6060, members: [{ userId: X, lang: "ru" }, { userId: Y, lang: "es" }] };
    await recapWindow(
      { closedWindowId: w, newWindowId: fresh.id, couple },
      { deliver, recapAndFold: async () => ({ recap: [{ lang: "ru", text: "итог" }, { lang: "es", text: "resumen" }] }) },
    );
    const [message] = deliver.mock.calls[0];
    expect(message.key).toBe(`recap:${w}`);
    expect(message.params.disable_notification).toBe(true);
    expect(message.params.text).toContain("resumen");
  });
});

describe("сворачивание", () => {
  it("личка: шифрованная сводка, покрытые строки удалены (DR22)", async () => {
    for (const t of ["раз", "два"]) {
      await sql`insert into messages (couple_id, scope, owner_user_id, author_user_id, text) values (${coupleId}, 'dm', ${X}, ${X}, ${encrypt(t, `dm:${X}`)})`;
    }
    const generateFn = summaryOk("DM_SUMMARY");
    expect((await foldDm(coupleId, X, { generateFn })).folded).toBe(true);
    const [s] = await sql`select text from summaries where scope_key = ${`dm:${X}`}`;
    expect(decrypt(s.text, `dm:${X}`)).toBe("DM_SUMMARY");
    expect(await sql`select id from messages where scope = 'dm'`).toHaveLength(0);
    expect(generateFn.mock.calls[0][0].parts[0].text).toContain("раз");
  });

  it("группа: заметки на вход не подаются (R15)", async () => {
    await sql`insert into messages (couple_id, scope, author_user_id, text) values (${coupleId}, 'group', ${X}, 'реплика')`;
    await sql`insert into notes (couple_id, author_user_id, text, approved_at) values (${coupleId}, ${Y}, 'СЕКРЕТНАЯ_ЗАМЕТКА', now())`;
    const generateFn = summaryOk();
    await foldGroup(coupleId, { generateFn });
    expect(generateFn.mock.calls[0][0].parts[0].text).not.toContain("СЕКРЕТНАЯ_ЗАМЕТКА");
  });

  it("квота 70% — сводка не трогается", async () => {
    await sql`insert into messages (couple_id, scope, author_user_id, text) values (${coupleId}, 'group', ${X}, 'реплика')`;
    expect(await foldGroup(coupleId, { generateFn: vi.fn().mockResolvedValue({ unavailable: "quota" }) })).toEqual({ folded: false, reason: "quota" });
    expect(await sql`select 1 from summaries`).toHaveLength(0);
  });
});

describe("cron", () => {
  it("лички старше 6 дней удаляются даже несвёрнутые; группа — только покрытая и старше 90 дней", async () => {
    await sql`insert into messages (couple_id, scope, owner_user_id, author_user_id, text, created_at) values
      (${coupleId}, 'dm', ${X}, ${X}, 'x', now() - interval '6 days 1 hour')`;
    await sql`insert into messages (couple_id, scope, author_user_id, text, created_at) values
      (${coupleId}, 'group', ${X}, 'старое несвёрнутое', now() - interval '91 days')`;
    const report = await runMaintenance({
      handle: vi.fn(),
      foldDmFn: vi.fn(),
      foldGroupFn: vi.fn().mockResolvedValue({ folded: false, reason: "quota" }),
      refreshFn: vi.fn(),
      reencryptFn: vi.fn().mockResolvedValue(0),
    });
    expect(report.purge.dm).toBe(1);
    expect(await sql`select text from messages where scope = 'group'`).toEqual([{ text: "старое несвёрнутое" }]);
  });

  it("зависший в фолбэке апдейт дообрабатывается, payload стирается (R10, R27)", async () => {
    const update = { update_id: 777, message: { text: "x" } };
    await sql`insert into processed_updates (update_id, status, payload, received_at) values (777, 'received', ${sealUpdate(update)}, now() - interval '20 minutes')`;
    const handle = vi.fn();
    await runMaintenance({ handle, foldDmFn: vi.fn(), foldGroupFn: vi.fn(), refreshFn: vi.fn(), reencryptFn: vi.fn().mockResolvedValue(0) });
    expect(handle).toHaveBeenCalledWith(update);
    const [row] = await sql`select status, payload from processed_updates where update_id = 777`;
    expect(row).toEqual({ status: "done", payload: null });
  });

  it("номера помощи: страны без кеша подтягиваются", async () => {
    await sql`update members set country = 'ES' where user_id = ${X}`;
    const refreshFn = vi.fn();
    await runMaintenance({ handle: vi.fn(), foldDmFn: vi.fn(), foldGroupFn: vi.fn(), refreshFn, reencryptFn: vi.fn().mockResolvedValue(0) });
    expect(refreshFn).toHaveBeenCalledWith("ES");
  });

  it("перешифровка после ротации ключа (R18)", async () => {
    await sql`insert into messages (couple_id, scope, owner_user_id, author_user_id, text) values (${coupleId}, 'dm', ${X}, ${X}, ${encrypt("личное", `dm:${X}`)})`;
    process.env.DM_ENCRYPTION_KEY = keyB;
    process.env.DM_ENCRYPTION_KEY_VERSION = "2";
    process.env.DM_ENCRYPTION_KEY_PREV = keyA;
    const report = await runMaintenance({ handle: vi.fn(), foldDmFn: vi.fn(), foldGroupFn: vi.fn(), refreshFn: vi.fn() });
    expect(report.reencrypt.rewritten).toBe(1);
    const [m] = await sql`select text from messages where scope = 'dm'`;
    expect(m.text.startsWith("v2.")).toBe(true);
    delete process.env.DM_ENCRYPTION_KEY_PREV;
    expect(decrypt(m.text, `dm:${X}`)).toBe("личное");
  });
});
