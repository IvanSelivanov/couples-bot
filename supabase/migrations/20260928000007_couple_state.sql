-- Couple state machine (R6, R12, R25, DR19). One atomic transition in SQL:
-- the couple row is locked, the decision and all side effects are in one
-- transaction; otherwise a /pause in the middle of reply generation could diverge from
-- can_publish.
--
--              activate (/start + admin + 2 consents)
--  onboarding ─────────────────────────────▶ active ◀── resume (paused_by only, DR19)
--                                              │  ▲
--                                        pause │  │
--                                              ▼  │
--                                            paused
--  active/paused/suspended ── revoke ──▶ revoked ── consent (everyone agreed) ──▶ paused if paused_by (R25), else active
--  active/paused ── suspend (third person / admin lost) ──▶ suspended ── restore ──▶ paused if paused_by, else active
--  active ── crisis (in the group) ──▶ active: only close the window and cancel /check
--
-- Every exit from active (and crisis): close the open window releasing the lease,
-- cancel the active /check. Every change: state_version += 1 (R12), so a
-- generation already in progress doesn't publish its reply.

create function couple_transition(p_couple_id bigint, p_event text, p_actor bigint default null)
returns jsonb
language plpgsql
as $$
declare
  c        couples%rowtype;
  v_to     text;
  v_other_revoked boolean;
begin
  select * into c from couples where id = p_couple_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_couple');
  end if;

  case p_event
    when 'activate' then
      if c.state <> 'onboarding' then return jsonb_build_object('ok', false, 'reason', 'not_onboarding', 'state', c.state); end if;
      v_to := 'active';

    when 'pause' then
      if c.state <> 'active' then return jsonb_build_object('ok', false, 'reason', 'not_active', 'state', c.state); end if;
      v_to := 'paused';

    when 'resume' then
      if c.state <> 'paused' then return jsonb_build_object('ok', false, 'reason', 'not_paused', 'state', c.state); end if;
      -- DR19: only the person who paused can resume, always.
      if c.paused_by is distinct from p_actor then
        return jsonb_build_object('ok', false, 'reason', 'not_pauser', 'state', c.state);
      end if;
      v_to := 'active';

    when 'revoke' then
      if c.state not in ('active', 'paused', 'suspended', 'revoked') then
        return jsonb_build_object('ok', false, 'reason', 'not_allowed', 'state', c.state);
      end if;
      update members set revoked_at = now() where couple_id = p_couple_id and user_id = p_actor;
      v_to := 'revoked';

    when 'consent' then
      if c.state <> 'revoked' then return jsonb_build_object('ok', false, 'reason', 'not_revoked', 'state', c.state); end if;
      update members set revoked_at = null, consented_at = now() where couple_id = p_couple_id and user_id = p_actor;
      select exists (select 1 from members where couple_id = p_couple_id and revoked_at is not null)
        into v_other_revoked;
      if v_other_revoked then
        -- One partner gave consent back, the other still revoked: the couple stays revoked.
        return jsonb_build_object('ok', true, 'from', c.state, 'to', c.state, 'changed', false);
      end if;
      -- R25: a pause survives consent revocation.
      v_to := case when c.paused_by is not null then 'paused' else 'active' end;

    when 'suspend' then
      if c.state not in ('active', 'paused') then
        return jsonb_build_object('ok', false, 'reason', 'not_allowed', 'state', c.state);
      end if;
      v_to := 'suspended';

    when 'restore' then
      if c.state <> 'suspended' then return jsonb_build_object('ok', false, 'reason', 'not_suspended', 'state', c.state); end if;
      v_to := case when c.paused_by is not null then 'paused' else 'active' end;

    when 'crisis' then
      if c.state <> 'active' then return jsonb_build_object('ok', false, 'reason', 'not_active', 'state', c.state); end if;
      v_to := 'active';

    else
      raise exception 'неизвестное событие пары: %', p_event;
  end case;

  -- Leaving active, and crisis: the window and /check stop without separate messages.
  if c.state = 'active' and (v_to <> 'active' or p_event = 'crisis') then
    update windows set ended_at = now(), lease_id = null, generating_until = null
     where couple_id = p_couple_id and ended_at is null;
    update checks set ended_at = now(), state = 'cancelled'
     where couple_id = p_couple_id and ended_at is null;
  end if;

  update couples
     set state = v_to,
         state_version = state_version + 1,
         paused_by = case
           when p_event = 'pause' then p_actor
           when p_event = 'resume' then null
           else paused_by
         end,
         paused_at = case
           when p_event = 'pause' then now()
           when p_event = 'resume' then null
           else paused_at
         end
   where id = p_couple_id;

  return jsonb_build_object('ok', true, 'from', c.state, 'to', v_to, 'changed', true,
                            'state_version', c.state_version + 1);
end;
$$;

revoke execute on function couple_transition(bigint, text, bigint) from public, anon, authenticated;
grant execute on function couple_transition(bigint, text, bigint) to service_role;
