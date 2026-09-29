-- Private chat (T23): storage with time-based deletion on every message (R24, R27),
-- drafts waiting for text, note offers at most once per window (DR11).

-- A draft waits for text (/draft without text) or for an edit request (DR10).
alter table drafts drop constraint drafts_status_check;
alter table drafts add constraint drafts_status_check
  check (status in ('awaiting_text', 'awaiting_edit', 'editing', 'sending', 'unknown'));

-- A note waits for the owner's corrected text (DR11 "Edit").
alter table notes add column awaiting_edit boolean not null default false;

-- When the bot last offered a note to this member (DR11).
alter table members add column last_note_offer_at timestamptz;

-- A private message: insert and delete the owner's rows older than the threshold in
-- one call, so the "up to 7 days" promise holds even without cron (R27).
create function ingest_dm_message(
  p_couple_id bigint, p_owner bigint, p_author bigint, p_is_bot boolean,
  p_tg_message_id bigint, p_text text, p_kind text default 'text', p_retention_days integer default 6
)
returns bigint
language plpgsql
as $$
declare
  v_id bigint;
begin
  delete from messages
   where scope = 'dm' and owner_user_id = p_owner
     and created_at < now() - make_interval(days => p_retention_days);

  insert into messages (couple_id, scope, owner_user_id, author_user_id, is_bot, kind, tg_chat_id, tg_message_id, text)
  values (p_couple_id, 'dm', p_owner, p_author, p_is_bot, p_kind, p_owner, p_tg_message_id, p_text)
  on conflict (couple_id, scope, tg_chat_id, tg_message_id) do nothing
  returning id into v_id;
  return v_id;
end;
$$;

revoke execute on function ingest_dm_message(bigint, bigint, bigint, boolean, bigint, text, text, integer) from public, anon, authenticated;
grant execute on function ingest_dm_message(bigint, bigint, bigint, boolean, bigint, text, text, integer) to service_role;
