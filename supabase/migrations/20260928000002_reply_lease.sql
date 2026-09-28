-- Аренда права ответить в окне разговора (R2, R11, R12).
--
-- Условие и время проверяет Postgres: у PostgREST-фильтров нет now(), а часы
-- инстансов Vercel не синхронны друг с другом. Поэтому CAS живёт здесь, а
-- lib/db.js зовёт эти функции через POST /rest/v1/rpc/<имя>.
--
--   claim_reply_window ─▶ lease_id | null
--        │ генерация (бюджет = срок аренды − 15 с)
--        ▼
--   can_publish ─▶ true: отправить; false: молча выбросить ответ
--        ▼
--   finish_reply ─▶ {ok, newer_message_id}: newer ≠ null — поставить новую
--                   проверку дебаунса на хвост (R11)

-- Захватывает окно, если маркер не сдвинулся и чужой живой аренды нет.
create function claim_reply_window(p_window_id bigint, p_expected_marker bigint, p_lease_seconds integer default 90)
returns uuid
language sql
as $$
  update windows
     set lease_id = gen_random_uuid(),
         generating_until = now() + make_interval(secs => p_lease_seconds)
   where id = p_window_id
     and ended_at is null
     and answered_up_to = p_expected_marker
     and (generating_until is null or generating_until < now())
  returning lease_id;
$$;

-- Право опубликовать ответ прямо перед sendMessage: аренда своя и живая,
-- окно открыто, пара active, состояние пары не менялось с начала генерации.
create function can_publish(p_window_id bigint, p_lease_id uuid, p_state_version integer)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
      from windows w
      join couples c on c.id = w.couple_id
     where w.id = p_window_id
       and w.lease_id = p_lease_id
       and w.generating_until > now()
       and w.ended_at is null
       and c.state = 'active'
       and c.state_version = p_state_version
  );
$$;

-- Сдвигает маркер и снимает аренду, только если аренда своя. В той же
-- транзакции сообщает, пришли ли за время генерации новые реплики партнёров:
-- их никто не покроет, если не поставить для них новую проверку (R11).
create function finish_reply(p_window_id bigint, p_lease_id uuid, p_new_marker bigint)
returns jsonb
language plpgsql
as $$
declare
  v_couple_id bigint;
  v_newer     bigint;
begin
  update windows
     set answered_up_to = p_new_marker,
         lease_id = null,
         generating_until = null
   where id = p_window_id
     and lease_id = p_lease_id
  returning couple_id into v_couple_id;

  if v_couple_id is null then
    return jsonb_build_object('ok', false, 'newer_message_id', null);
  end if;

  select max(id) into v_newer
    from messages
   where couple_id = v_couple_id
     and scope = 'group'
     and not is_bot
     and id > p_new_marker;

  return jsonb_build_object('ok', true, 'newer_message_id', v_newer);
end;
$$;

-- Функции доступны только серверу с service key.
revoke execute on function claim_reply_window(bigint, bigint, integer) from public, anon, authenticated;
revoke execute on function can_publish(bigint, uuid, integer) from public, anon, authenticated;
revoke execute on function finish_reply(bigint, uuid, bigint) from public, anon, authenticated;
grant execute on function claim_reply_window(bigint, bigint, integer) to service_role;
grant execute on function can_publish(bigint, uuid, integer) to service_role;
grant execute on function finish_reply(bigint, uuid, bigint) to service_role;
