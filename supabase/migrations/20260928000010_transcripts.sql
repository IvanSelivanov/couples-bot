-- The helper's reply waits for voice transcriptions (R22), and late results (R26).
--
--   voice ─▶ pending ─ transcription ─ CAS pending→done ─▶ text, debounce check
--            │         └ already failed ──▶ text with late = true, no check
--            └ 120 s without a result ─ expire_transcripts ─▶ failed
--
-- The status changes exactly once. claim_reply_window grants no lease while the
-- unanswered block has a pending one: the helper's reply always takes voice into account.

create function expire_transcripts(p_couple_id bigint, p_seconds integer default 120)
returns integer
language sql
as $$
  with expired as (
    update messages set transcript_status = 'failed'
     where couple_id = p_couple_id
       and transcript_status = 'pending'
       and created_at < now() - make_interval(secs => p_seconds)
    returning 1
  )
  select count(*)::integer from expired;
$$;

-- Transcription result. { applied: true } means on time; { late: true } means after failed.
create function set_transcript(p_message_id bigint, p_text text, p_lang text default null)
returns jsonb
language plpgsql
as $$
declare
  v_status text;
begin
  update messages
     set transcript_status = 'done', text = p_text, lang = coalesce(p_lang, lang)
   where id = p_message_id and transcript_status = 'pending'
  returning transcript_status into v_status;
  if v_status is not null then
    return jsonb_build_object('applied', true, 'late', false);
  end if;

  update messages
     set text = p_text, lang = coalesce(p_lang, lang), transcript_late = true
   where id = p_message_id and transcript_status = 'failed'
  returning transcript_status into v_status;
  if v_status is not null then
    return jsonb_build_object('applied', false, 'late', true);
  end if;

  -- done earlier (repeated delivery) or no such message: do nothing.
  return jsonb_build_object('applied', false, 'late', false);
end;
$$;

create or replace function claim_reply_window(p_window_id bigint, p_expected_marker bigint, p_lease_seconds integer default 90)
returns uuid
language sql
as $$
  update windows w
     set lease_id = gen_random_uuid(),
         generating_until = now() + make_interval(secs => p_lease_seconds)
   where w.id = p_window_id
     and w.ended_at is null
     and w.answered_up_to = p_expected_marker
     and (w.generating_until is null or w.generating_until < now())
     and not exists (
       select 1 from messages m
        where m.couple_id = w.couple_id
          and m.scope = 'group'
          and m.id > w.answered_up_to
          and m.transcript_status = 'pending'
     )
  returning w.lease_id;
$$;

create or replace function debounce_state(p_window_id bigint)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'answered_up_to', w.answered_up_to,
    'ended', w.ended_at is not null,
    'check_active', exists (select 1 from checks k where k.couple_id = w.couple_id and k.ended_at is null),
    'pending_transcripts', (
      select count(*) from messages m
       where m.couple_id = w.couple_id and m.scope = 'group'
         and m.id > w.answered_up_to and m.transcript_status = 'pending'
    ),
    'latest_id', (
      select max(m.id) from messages m
       where m.couple_id = w.couple_id and m.scope = 'group' and not m.is_bot
    ),
    'latest_at', (
      select max(m.created_at) from messages m
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

revoke execute on function expire_transcripts(bigint, integer) from public, anon, authenticated;
revoke execute on function set_transcript(bigint, text, text) from public, anon, authenticated;
grant execute on function expire_transcripts(bigint, integer) to service_role;
grant execute on function set_transcript(bigint, text, text) to service_role;
