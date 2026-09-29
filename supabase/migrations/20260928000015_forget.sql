-- Deleting data on request (design doc "Revocation and deletion", DR16, DR20, R15).
--
-- /forget        — the owner's private chat, drafts, notes and the dm:X summary;
-- /forget_group  — the shared history and the group summary; one partner is enough;
--                  does NOT touch abuse flags (DR20): a flag is a safety rule
--                  without conversation text, and one command can't remove it;
-- /flag_clear    — only X's own dm:X flags.

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
  -- Windows without messages are meaningless; reply markers go away with them.
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

-- Whether there was a signal from X's private chat (an active dm:X flag), for the
-- anonymity warning before /pause and /revoke (design doc "Pauses and revocation aren't anonymous").
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
