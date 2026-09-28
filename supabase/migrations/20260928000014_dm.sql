-- Личка (T23): хранение с удалением по сроку при каждом сообщении (R24, R27),
-- черновики с ожиданием текста, предложения заметок не чаще раза за окно (DR11).

-- Черновик ждёт текст (/draft без текста) или пожелание к правке (DR10).
alter table drafts drop constraint drafts_status_check;
alter table drafts add constraint drafts_status_check
  check (status in ('awaiting_text', 'awaiting_edit', 'editing', 'sending', 'unknown'));

-- Заметка ждёт исправленного текста владельца (DR11 «Изменить»).
alter table notes add column awaiting_edit boolean not null default false;

-- Когда бот последний раз предлагал заметку этому участнику (DR11).
alter table members add column last_note_offer_at timestamptz;

-- Реплика лички: вставка и удаление строк владельца старше порога — одним
-- вызовом, чтобы обещание «до 7 дней» держалось и без cron (R27).
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
