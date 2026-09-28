-- Состояние дебаунса окна одним запросом (R1, R11): маркер ответа, последняя
-- и первая неотвеченная реплика партнёров в группе. Сообщения бота и личек
-- дебаунс не сбрасывают (дизайн-док, «Дебаунс»).

create function debounce_state(p_window_id bigint)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'answered_up_to', w.answered_up_to,
    'ended', w.ended_at is not null,
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

revoke execute on function debounce_state(bigint) from public, anon, authenticated;
grant execute on function debounce_state(bigint) to service_role;
