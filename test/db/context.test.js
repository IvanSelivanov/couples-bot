// T9: граница данных контекста на живой базе (R15, «Граница в коде»).
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ContextRefused, buildDmContext, buildGroupContext } from "../../lib/context.js";
import { encrypt } from "../../lib/crypto.js";
import { connect, truncateAll, useLocalSupabase } from "./helpers.js";

const sql = connect();
beforeAll(() => {
  useLocalSupabase();
  process.env.DM_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.DM_ENCRYPTION_KEY_VERSION = "1";
});
afterAll(() => sql.end());

const X = 101;
const Y = 202;
let coupleId;

// Полный набор данных пары, где у каждого куска свой маркер в тексте.
beforeEach(async () => {
  await truncateAll(sql);
  const [c] = await sql`insert into couples (group_chat_id, state) values (-1, 'active') returning id`;
  coupleId = c.id;
  await sql`insert into members (user_id, couple_id, consented_at) values (${X}, ${coupleId}, now()), (${Y}, ${coupleId}, now())`;

  let tg = 1;
  const msg = (scope, author, text, owner = null) => sql`
    insert into messages (couple_id, scope, owner_user_id, author_user_id, tg_chat_id, tg_message_id, text)
    values (${coupleId}, ${scope}, ${owner}, ${author}, 1, ${tg++}, ${text})
  `;
  await msg("group", X, "GROUP_X");
  await msg("group", Y, "GROUP_Y");
  await msg("guest", Y, "GUEST_Y");
  await msg("dm", X, encrypt("DM_OF_X", `dm:${X}`), X);
  await msg("dm", Y, encrypt("DM_OF_Y", `dm:${Y}`), Y);

  await sql`insert into summaries (couple_id, scope_key, text) values
    (${coupleId}, 'group', 'SUMMARY_GROUP'),
    (${coupleId}, ${`dm:${X}`}, ${encrypt("SUMMARY_DM_X", `dm:${X}`)}),
    (${coupleId}, ${`dm:${Y}`}, ${encrypt("SUMMARY_DM_Y", `dm:${Y}`)})`;

  await sql`insert into notes (couple_id, author_user_id, text, approved_at, revoked_at) values
    (${coupleId}, ${Y}, 'NOTE_ACTIVE_Y', now(), null),
    (${coupleId}, ${Y}, null, now(), now()),
    (${coupleId}, ${X}, 'NOTE_UNAPPROVED_X', null, null)`;

  await sql`insert into drafts (couple_id, user_id, original, reformulated) values
    (${coupleId}, ${Y}, 'DRAFT_Y', 'DRAFT_Y_REFORMULATED')`;
});

const dump = (ctx) => JSON.stringify(ctx);

describe("групповой контекст", () => {
  it("общая история, сводка group и активные заметки", async () => {
    const text = dump(await buildGroupContext(coupleId));
    for (const s of ["GROUP_X", "GROUP_Y", "GUEST_Y", "SUMMARY_GROUP", "NOTE_ACTIVE_Y"]) expect(text).toContain(s);
  });

  it("ни одной лички, dm-сводки, черновика или неодобренной заметки", async () => {
    const text = dump(await buildGroupContext(coupleId));
    for (const s of ["DM_OF", "SUMMARY_DM", "DRAFT", "NOTE_UNAPPROVED", "v1."]) expect(text).not.toContain(s);
  });

  it("пара не active — отказ", async () => {
    await sql`update couples set state = 'paused' where id = ${coupleId}`;
    await expect(buildGroupContext(coupleId)).rejects.toThrow(ContextRefused);
  });
});

describe("контекст лички X", () => {
  it("своя личка расшифрована, общая история и заметки есть", async () => {
    const ctx = await buildDmContext(coupleId, X);
    const text = dump(ctx);
    for (const s of ["DM_OF_X", "SUMMARY_DM_X", "GROUP_Y", "SUMMARY_GROUP", "NOTE_ACTIVE_Y"]) expect(text).toContain(s);
  });

  it("нет лички Y, dm-сводки Y и черновиков Y", async () => {
    const text = dump(await buildDmContext(coupleId, X));
    for (const s of ["DM_OF_Y", "SUMMARY_DM_Y", "DRAFT_Y"]) expect(text).not.toContain(s);
  });

  it("отозванной заметки нет в следующем контексте", async () => {
    await sql`update notes set text = null, revoked_at = now() where text = 'NOTE_ACTIVE_Y'`;
    expect(dump(await buildDmContext(coupleId, X))).not.toContain("NOTE_ACTIVE_Y");
    expect(dump(await buildGroupContext(coupleId))).not.toContain("NOTE_ACTIVE_Y");
  });

  it("Y отозвал согласие — у X только своя личка", async () => {
    await sql`update members set revoked_at = now() where user_id = ${Y}`;
    const ctx = await buildDmContext(coupleId, X);
    const text = dump(ctx);
    expect(text).toContain("DM_OF_X");
    for (const s of ["GROUP_", "GUEST_", "SUMMARY_GROUP", "NOTE_", "DM_OF_Y"]) expect(text).not.toContain(s);
  });

  it("X сам отозвал согласие — отказ", async () => {
    await sql`update members set revoked_at = now() where user_id = ${X}`;
    await expect(buildDmContext(coupleId, X)).rejects.toThrow(/отозвал/);
  });

  it("строку лички Y, переставленную к X, расшифровать нельзя", async () => {
    await sql`update messages set owner_user_id = ${X} where owner_user_id = ${Y}`;
    await expect(buildDmContext(coupleId, X)).rejects.toThrow();
  });

  it("постороннему — отказ", async () => {
    await expect(buildDmContext(coupleId, 999)).rejects.toThrow(/не участник/);
  });
});
