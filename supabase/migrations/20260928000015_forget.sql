-- Удаление данных по просьбе (дизайн-док «Отзыв и удаление», DR16, DR20, R15).
--
-- /forget        — личка, черновики, заметки и сводка dm:X владельца;
-- /forget_group  — общая история и сводка group; хватает одного партнёра;
--                  абьюз-флаги НЕ трогает (DR20): флаг — правило безопасности
--                  без текста переписки, и снять его одной командой нельзя;
-- /flag_clear    — только флаги dm:X самого X.

create function forget_member(p_user_id bigint)
returns jsonb
language plpgsql
as $$
declare
  v_couple bigint;
  v_messages integer;
  v_drafts integer;
  v_notes integer;
begin
  select couple_id into v_couple from members where user_id = p_user_id;
  if v_couple is null then return jsonb_build_object('ok', false); end if;

  with d as (delete from messages where scope = 'dm' and owner_user_id = p_user_id returning 1)
  select count(*) into v_messages from d;
  with d as (delete from drafts where user_id = p_user_id returning 1)
  select count(*) into v_drafts from d;
  with d as (delete from notes where author_user_id = p_user_id returning 1)
  select count(*) into v_notes from d;
  delete from summaries where couple_id = v_couple and scope_key = 'dm:' || p_user_id;

  return jsonb_build_object('ok', true, 'messages', v_messages, 'drafts', v_drafts, 'notes', v_notes);
end;
$$;

create function forget_group(p_couple_id bigint)
returns jsonb
language plpgsql
as $$
declare
  v_messages integer;
begin
  with d as (delete from messages where couple_id = p_couple_id and scope in ('group', 'guest') returning 1)
  select count(*) into v_messages from d;
  delete from summaries where couple_id = p_couple_id and scope_key = 'group';
  -- Окна без сообщений бессмысленны; маркеры ответа обнулятся вместе с ними.
  delete from windows where couple_id = p_couple_id;
  return jsonb_build_object('ok', true, 'messages', v_messages);
end;
$$;

create function flag_clear(p_user_id bigint)
returns integer
language sql
as $$
  with c as (
    update abuse_flags set cleared_at = now()
     where source = 'dm:' || p_user_id and cleared_at is null
    returning 1
  )
  select count(*)::integer from c;
$$;

-- Был ли сигнал из лички X (активный флаг dm:X) — для предупреждения об
-- анонимности перед /pause и /revoke (дизайн-док «Паузы и отзыв не анонимны»).
create function has_own_signal(p_user_id bigint)
returns boolean
language sql
stable
as $$
  select exists (select 1 from abuse_flags where source = 'dm:' || p_user_id and cleared_at is null);
$$;

revoke execute on function forget_member(bigint) from public, anon, authenticated;
revoke execute on function forget_group(bigint) from public, anon, authenticated;
revoke execute on function flag_clear(bigint) from public, anon, authenticated;
revoke execute on function has_own_signal(bigint) from public, anon, authenticated;
grant execute on function forget_member(bigint) to service_role;
grant execute on function forget_group(bigint) to service_role;
grant execute on function flag_clear(bigint) to service_role;
grant execute on function has_own_signal(bigint) to service_role;
