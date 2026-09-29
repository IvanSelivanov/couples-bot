-- /check, speaker-listener (design doc "/check", R14, R16, DR6).
--
-- One active exercise per couple; a repeat no sooner than 30 minutes after the
-- previous one started is the only reason to refuse (D15, D17).
-- Transitions are a conditional UPDATE on (state, round): a stale button or a
-- double tap simply doesn't find the row.

alter table checks add column prompt_message_id bigint;     -- the bot message the listener replies to
alter table checks add column hinted boolean not null default false;
alter table checks add column updated_at timestamptz not null default now();
alter table checks add column outcome text;                 -- understood | discuss_more | skipped | timeout | cancelled

create unique index checks_one_active_per_couple on checks (couple_id) where ended_at is null;

create function check_start(
  p_couple_id bigint, p_speaker bigint, p_listener bigint, p_block_from bigint, p_block_to bigint,
  p_cooldown_minutes integer default 30
)
returns jsonb
language plpgsql
as $$
declare
  v_last  timestamptz;
  v_id    bigint;
begin
  -- Locking the couple serialises simultaneous /check from both partners.
  perform 1 from couples where id = p_couple_id for update;

  if exists (select 1 from checks where couple_id = p_couple_id and ended_at is null) then
    return jsonb_build_object('ok', false, 'reason', 'active');
  end if;

  select max(started_at) into v_last from checks where couple_id = p_couple_id;
  if v_last is not null and v_last > now() - make_interval(mins => p_cooldown_minutes) then
    return jsonb_build_object(
      'ok', false, 'reason', 'cooldown',
      'retry_in_minutes', ceil(extract(epoch from (v_last + make_interval(mins => p_cooldown_minutes) - now())) / 60)
    );
  end if;

  insert into checks (couple_id, speaker_user_id, listener_user_id, block_from, block_to, state)
  values (p_couple_id, p_speaker, p_listener, p_block_from, p_block_to, 'awaiting_paraphrase')
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

revoke execute on function check_start(bigint, bigint, bigint, bigint, bigint, integer) from public, anon, authenticated;
grant execute on function check_start(bigint, bigint, bigint, bigint, bigint, integer) to service_role;

-- While /check is active, no debounce replies are generated (design doc "/check").
create or replace function debounce_state(p_window_id bigint)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'answered_up_to', w.answered_up_to,
    'ended', w.ended_at is not null,
    'check_active', exists (select 1 from checks k where k.couple_id = w.couple_id and k.ended_at is null),
    'latest_id', (
      select max(m.id) from messages m
       where m.couple_id = w.couple_id and m.scope = 'group' and not m.is_bot
    ),
    'first_unanswered_id', (
      select min(m.id) from messages m
       where m.couple_id = w.couple_id and m.scope = 'group' and not m.is_bot
         and m.id > w.answered_up_to
    )
  )
  from windows w
  where w.id = p_window_id;
$$;
