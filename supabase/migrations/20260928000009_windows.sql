-- Окна разговора и приём реплики группы одной транзакцией (DR9, R21, R22, R26).
--
-- ingest_group_message:
--   1. блокирует строку пары — параллельные реплики обоих партнёров
--      обрабатываются по очереди (R21: одно открытое окно);
--   2. окно, молчащее дольше порога, закрывает и открывает новое;
--   3. вставляет реплику (дубль апдейта — on conflict, R3);
--   4. сдвигает last_message_at окна.
-- Возвращает id реплики, id окна и id только что закрытого окна (для итога, R30).

create function open_or_get_window(p_couple_id bigint, p_silence_minutes integer default 30)
returns jsonb
language plpgsql
as $$
declare
  w       windows%rowtype;
  v_closed bigint;
begin
  perform 1 from couples where id = p_couple_id for update;

  select * into w from windows where couple_id = p_couple_id and ended_at is null;
  if found and w.last_message_at < now() - make_interval(mins => p_silence_minutes) then
    update windows set ended_at = now(), lease_id = null, generating_until = null where id = w.id;
    v_closed := w.id;
    w := null;
  end if;

  if w.id is null then
    insert into windows (couple_id) values (p_couple_id) returning * into w;
  end if;

  return jsonb_build_object('window_id', w.id, 'closed_window_id', v_closed);
end;
$$;

create function ingest_group_message(
  p_couple_id bigint, p_author bigint, p_tg_chat_id bigint, p_tg_message_id bigint,
  p_text text, p_kind text default 'text', p_lang text default null, p_silence_minutes integer default 30
)
returns jsonb
language plpgsql
as $$
declare
  v_window   jsonb;
  v_msg      bigint;
begin
  v_window := open_or_get_window(p_couple_id, p_silence_minutes);

  insert into messages (couple_id, scope, author_user_id, kind, tg_chat_id, tg_message_id, text, lang, transcript_status)
  values (
    p_couple_id, 'group', p_author, p_kind, p_tg_chat_id, p_tg_message_id, p_text, p_lang,
    case when p_kind in ('voice', 'video_note') then 'pending' end
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

-- Первый опубликованный ответ ведущего в окне (DR23: итог только после него;
-- R30: опоздавший итог старого окна отбрасывается, если новое уже ответило).
create function mark_first_reply(p_window_id bigint)
returns void
language sql
as $$
  update windows set first_reply_at = coalesce(first_reply_at, now()) where id = p_window_id;
$$;

revoke execute on function open_or_get_window(bigint, integer) from public, anon, authenticated;
revoke execute on function ingest_group_message(bigint, bigint, bigint, bigint, text, text, text, integer) from public, anon, authenticated;
revoke execute on function mark_first_reply(bigint) from public, anon, authenticated;
grant execute on function open_or_get_window(bigint, integer) to service_role;
grant execute on function ingest_group_message(bigint, bigint, bigint, bigint, text, text, text, integer) to service_role;
grant execute on function mark_first_reply(bigint) to service_role;
