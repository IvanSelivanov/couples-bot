-- Once-a-day guard for the maintenance cron.
--
-- Vercel sends "Authorization: Bearer <CRON_SECRET>" only when CRON_SECRET is set.
-- A one-click setup has no CRON_SECRET, so /api/cron can't tell Vercel from a
-- stranger. Instead, a run is allowed at most once per interval: a stranger's
-- call can at worst run the daily maintenance a little early, and the real cron
-- then finds nothing to do.

create table maintenance_runs (
  id          int primary key default 1 check (id = 1),
  last_run_at timestamptz not null
);
alter table maintenance_runs enable row level security;

-- true: this call may run maintenance (and the run is recorded); false: too soon.
create function maintenance_claim(p_min_interval_seconds int) returns boolean
language plpgsql as $$
declare
  v_claimed boolean;
begin
  insert into maintenance_runs (id, last_run_at) values (1, now())
  on conflict (id) do update set last_run_at = now()
    where maintenance_runs.last_run_at < now() - make_interval(secs => p_min_interval_seconds)
  returning true into v_claimed;
  return coalesce(v_claimed, false);
end;
$$;

revoke execute on function maintenance_claim(int) from public, anon, authenticated;
grant execute on function maintenance_claim(int) to service_role;
