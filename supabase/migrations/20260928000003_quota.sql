-- Daily Gemini request counter (design doc, "Degradation"; R20, R31).
--
-- The day is counted in Pacific time: Gemini daily quotas reset at midnight PT.
-- The decision and the increment are one atomic operation, otherwise two
-- parallel calls would both see 89% and both get through at 90%.

-- Takes one request if the share after it doesn't exceed the tier's threshold.
-- p_cutoff_pct is the call's tier: 70, 90 or 100.
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
