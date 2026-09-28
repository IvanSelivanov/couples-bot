-- Обращение к боту (@упоминание или реплай на его сообщение) — ответ всегда,
-- speak не применяется (DR23). Признак ставится при приёме реплики.

alter table messages add column addresses_bot boolean not null default false;

drop function ingest_group_message(bigint, bigint, bigint, bigint, text, text, text, integer);

create function ingest_group_message(
  p_couple_id bigint, p_author bigint, p_tg_chat_id bigint, p_tg_message_id bigint,
  p_text text, p_kind text default 'text', p_lang text default null, p_silence_minutes integer default 30,
  p_addresses_bot boolean default false
)
returns jsonb
language plpgsql
as $$
declare
  v_window   jsonb;
  v_msg      bigint;
begin
  v_window := open_or_get_window(p_couple_id, p_silence_minutes);

  insert into messages (couple_id, scope, author_user_id, kind, tg_chat_id, tg_message_id, text, lang, transcript_status, addresses_bot)
  values (
    p_couple_id, 'group', p_author, p_kind, p_tg_chat_id, p_tg_message_id, p_text, p_lang,
    case when p_kind in ('voice', 'video_note') then 'pending' end,
    p_addresses_bot
  )
  on conflict (couple_id, scope, tg_chat_id, tg_message_id) do nothing
  returning id into v_msg;

  if v_msg is null then
    select id into v_msg from messages
     where couple_id = p_couple_id and scope = 'group' and tg_chat_id = p_tg_chat_id and tg_message_id = p_tg_message_id;
    return v_window || jsonb_build_object('message_id', v_msg, 'duplicate', true);
  end if;

  update windows set last_message_at = now() where id = (v_window ->> 'window_id')::bigint;
  return v_window || jsonb_build_object('message_id', v_msg, 'duplicate', false);
end;
$$;

revoke execute on function ingest_group_message(bigint, bigint, bigint, bigint, text, text, text, integer, boolean) from public, anon, authenticated;
grant execute on function ingest_group_message(bigint, bigint, bigint, bigint, text, text, text, integer, boolean) to service_role;
