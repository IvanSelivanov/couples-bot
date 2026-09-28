-- Машина состояний пары (R6, R12, R25, DR19). Один атомарный переход в SQL:
-- строка пары блокируется, решение и все побочные эффекты — в одной
-- транзакции, иначе /pause посреди генерации ответа мог бы разойтись с
-- can_publish.
--
--              activate (/start + админ + 2 согласия)
--  onboarding ─────────────────────────────▶ active ◀── resume (только paused_by, DR19)
--                                              │  ▲
--                                        pause │  │
--                                              ▼  │
--                                            paused
--  active/paused/suspended ── revoke ──▶ revoked ── consent (все согласны) ──▶ paused, если paused_by (R25) / active
--  active/paused ── suspend (третий / потеря админки) ──▶ suspended ── restore ──▶ paused, если paused_by / active
--  active ── crisis (в группе) ──▶ active: только закрыть окно и отменить /check
--
-- Каждый выход из active (и crisis): закрыть открытое окно со снятием аренды,
-- отменить активный /check. Каждое изменение: state_version += 1 (R12), чтобы
-- уже идущая генерация не опубликовала ответ.

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
      -- DR19: снять паузу может только поставивший, всегда.
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
        -- Согласие вернул один, второй всё ещё отозвал: пара остаётся revoked.
        return jsonb_build_object('ok', true, 'from', c.state, 'to', c.state, 'changed', false);
      end if;
      -- R25: пауза переживает отзыв согласия.
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

  -- Выход из active и crisis: окно и /check останавливаются без отдельных сообщений.
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
