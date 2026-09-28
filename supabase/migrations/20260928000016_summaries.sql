-- Сводки и обслуживание по сроку (дизайн-док «Бюджет контекста», «Хранение»;
-- DR9, DR22, R10, R15, R24, R27, R30).

-- Окно с данными для итога (R30).
create function window_info(p_window_id bigint)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'couple_id', w.couple_id, 'started_at', w.started_at, 'ended_at', w.ended_at,
    'first_reply_at', w.first_reply_at
  )
  from windows w where w.id = p_window_id;
$$;

-- Сводка скоупа: запись с covers_up_to, только вперёд (старая сводка не
-- перезаписывает более новую при гонке двух сворачиваний).
create function upsert_summary(p_couple_id bigint, p_scope_key text, p_text text, p_covers_up_to bigint)
returns boolean
language plpgsql
as $$
declare
  v_applied boolean;
begin
  insert into summaries (couple_id, scope_key, text, covers_up_to, updated_at)
  values (p_couple_id, p_scope_key, p_text, p_covers_up_to, now())
  on conflict (couple_id, scope_key) do update
     set text = excluded.text, covers_up_to = excluded.covers_up_to, updated_at = now()
   where summaries.covers_up_to < excluded.covers_up_to
  returning true into v_applied;
  return coalesce(v_applied, false);
end;
$$;

-- Ежедневная чистка по сроку. Лички старше порога удаляются всегда, даже
-- несвёрнутые (R24). Группа — только строки, покрытые сводкой и старше
-- 90 дней. Служебные таблицы — по своим срокам.
create function cron_purge(
  p_dm_days integer default 6, p_group_days integer default 90,
  p_updates_days integer default 7, p_drafts_days integer default 7, p_outbound_days integer default 7
)
returns jsonb
language plpgsql
as $$
declare
  v_dm integer; v_group integer; v_updates integer; v_drafts integer; v_outbound integer; v_windows integer;
begin
  with d as (delete from messages where scope = 'dm' and created_at < now() - make_interval(days => p_dm_days) returning 1)
  select count(*) into v_dm from d;

  with d as (
    delete from messages m
     using summaries s
     where m.scope in ('group', 'guest') and s.couple_id = m.couple_id and s.scope_key = 'group'
       and m.id <= s.covers_up_to and m.created_at < now() - make_interval(days => p_group_days)
    returning 1
  )
  select count(*) into v_group from d;

  with d as (delete from processed_updates where status = 'done' and received_at < now() - make_interval(days => p_updates_days) returning 1)
  select count(*) into v_updates from d;
  -- Зависшие received с шифротекстом старше срока лички тоже уходят (R27).
  delete from processed_updates where received_at < now() - make_interval(days => p_dm_days);

  with d as (delete from drafts where status <> 'sending' and created_at < now() - make_interval(days => p_drafts_days) returning 1)
  select count(*) into v_drafts from d;

  with d as (delete from outbound where created_at < now() - make_interval(days => p_outbound_days) returning 1)
  select count(*) into v_outbound from d;

  -- Остатки окон закрываются молча: итог — только при живом закрытии (DR9).
  with d as (
    update windows set ended_at = now(), lease_id = null, generating_until = null
     where ended_at is null and last_message_at < now() - interval '30 minutes'
    returning 1
  )
  select count(*) into v_windows from d;

  return jsonb_build_object('dm', v_dm, 'group', v_group, 'updates', v_updates, 'drafts', v_drafts,
                            'outbound', v_outbound, 'windows', v_windows);
end;
$$;

-- Кандидаты на сворачивание.
-- Лички: разговор молчит 48 часов и есть несвёрнутые строки (DR22).
create function dm_fold_candidates(p_silence_hours integer default 48)
returns table (couple_id bigint, owner_user_id bigint)
language sql
stable
as $$
  select m.couple_id, m.owner_user_id
    from messages m
    left join summaries s on s.couple_id = m.couple_id and s.scope_key = 'dm:' || m.owner_user_id
   where m.scope = 'dm'
   group by m.couple_id, m.owner_user_id, s.covers_up_to
  having max(m.created_at) < now() - make_interval(hours => p_silence_hours)
     and max(m.id) > coalesce(s.covers_up_to, 0);
$$;

-- Группа: несвёрнутых больше порога или старейшая несвёрнутая подходит к сроку.
create function group_fold_candidates(p_max_unsummarized integer default 80, p_age_days integer default 85)
returns table (couple_id bigint)
language sql
stable
as $$
  select m.couple_id
    from messages m
    left join summaries s on s.couple_id = m.couple_id and s.scope_key = 'group'
   where m.scope in ('group', 'guest') and m.id > coalesce(s.covers_up_to, 0)
   group by m.couple_id
  having count(*) > p_max_unsummarized or min(m.created_at) < now() - make_interval(days => p_age_days);
$$;

-- Строки лички, покрытые свежей сводкой, удаляются сразу (DR22).
create function delete_covered_dm(p_couple_id bigint, p_owner bigint, p_covers_up_to bigint)
returns integer
language sql
as $$
  with d as (
    delete from messages where couple_id = p_couple_id and scope = 'dm' and owner_user_id = p_owner and id <= p_covers_up_to
    returning 1
  )
  select count(*)::integer from d;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'window_info(bigint)', 'upsert_summary(bigint, text, text, bigint)',
    'cron_purge(integer, integer, integer, integer, integer)', 'dm_fold_candidates(integer)',
    'group_fold_candidates(integer, integer)', 'delete_covered_dm(bigint, bigint, bigint)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
