-- Дневной счётчик запросов к Gemini (дизайн-док, «Деградация»; R20, R31).
--
-- День считается по тихоокеанскому времени: дневные квоты Gemini
-- сбрасываются в полночь PT. Решение и инкремент — одна атомарная операция,
-- иначе два параллельных вызова оба увидят 89% и оба пройдут на 90%.

-- Берёт один запрос, если после него доля не превысит порог уровня.
-- p_cutoff_pct — уровень вызова: 70, 90 или 100.
create function quota_take(p_daily_limit integer, p_cutoff_pct integer)
returns jsonb
language plpgsql
as $$
declare
  v_day  date := (now() at time zone 'America/Los_Angeles')::date;
  v_used integer;
begin
  insert into quota (day, requests) values (v_day, 0) on conflict (day) do nothing;

  update quota
     set requests = requests + 1
   where day = v_day
     and (requests + 1) * 100 <= p_daily_limit * p_cutoff_pct
  returning requests into v_used;

  if v_used is null then
    select requests into v_used from quota where day = v_day;
    return jsonb_build_object('allowed', false, 'used', v_used);
  end if;
  return jsonb_build_object('allowed', true, 'used', v_used);
end;
$$;

revoke execute on function quota_take(integer, integer) from public, anon, authenticated;
grant execute on function quota_take(integer, integer) to service_role;
