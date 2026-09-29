-- Step-by-step onboarding in the private chat (DR7, DR8, DR5, T19): language → country → time →
-- consent. The step is stored on the member; the group knows the pinned status.

alter table members add column onboarding_step text not null default 'lang'
  check (onboarding_step in ('lang', 'country', 'time', 'consent', 'done', 'declined'));
alter table couples add column status_message_id bigint;

-- Registers a couple member; doesn't let a third one in. Atomic under the couple
-- lock: two partners opening the bot at the same moment won't become three.
create function join_couple(p_couple_id bigint, p_user_id bigint, p_name text, p_lang_hint text)
returns jsonb
language plpgsql
as $$
declare
  v_count integer;
begin
  perform 1 from couples where id = p_couple_id for update;
  if exists (select 1 from members where user_id = p_user_id and couple_id = p_couple_id) then
    return jsonb_build_object('ok', true, 'existing', true);
  end if;
  if exists (select 1 from members where user_id = p_user_id) then
    return jsonb_build_object('ok', false, 'reason', 'other_couple');
  end if;
  select count(*) into v_count from members where couple_id = p_couple_id;
  if v_count >= 2 then
    return jsonb_build_object('ok', false, 'reason', 'full');
  end if;
  insert into members (user_id, couple_id, display_name, lang) values (p_user_id, p_couple_id, p_name, p_lang_hint);
  return jsonb_build_object('ok', true, 'existing', false);
end;
$$;

-- A member's consent. The second consent activates the couple (onboarding → active).
create function give_consent(p_user_id bigint)
returns jsonb
language plpgsql
as $$
declare
  v_couple bigint;
  v_consented integer;
  v_total integer;
  v_state text;
begin
  select couple_id into v_couple from members where user_id = p_user_id;
  if v_couple is null then return jsonb_build_object('ok', false, 'reason', 'not_member'); end if;
  perform 1 from couples where id = v_couple for update;

  update members set consented_at = now(), onboarding_step = 'done' where user_id = p_user_id;
  select count(*) filter (where consented_at is not null), count(*) into v_consented, v_total
    from members where couple_id = v_couple;
  select state into v_state from couples where id = v_couple;

  if v_state = 'onboarding' and v_total = 2 and v_consented = 2 then
    perform couple_transition(v_couple, 'activate', null);
    return jsonb_build_object('ok', true, 'couple_id', v_couple, 'activated', true);
  end if;
  return jsonb_build_object('ok', true, 'couple_id', v_couple, 'activated', false);
end;
$$;

revoke execute on function join_couple(bigint, bigint, text, text) from public, anon, authenticated;
revoke execute on function give_consent(bigint) from public, anon, authenticated;
grant execute on function join_couple(bigint, bigint, text, text) to service_role;
grant execute on function give_consent(bigint) to service_role;
