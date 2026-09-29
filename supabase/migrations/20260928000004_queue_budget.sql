-- Monthly Vercel Queues operations budget (R1). On Hobby the first 1,000,000
-- operations a month are free; exceeding a Hobby limit pauses the project until
-- the end of 30 days. So at 90% the bot switches to the no-queue fallback itself.
--
-- One message ≈ 3 operations (send + delivery + acknowledgement). The decision
-- and the increment are atomic, as in quota_take.

create function queue_budget_take(p_ops integer, p_monthly_limit integer, p_cutoff_pct integer)
returns boolean
language plpgsql
as $$
declare
  v_month date := date_trunc('month', now() at time zone 'UTC')::date;
  v_ops   integer;
begin
  insert into queue_ops (month, ops) values (v_month, 0) on conflict (month) do nothing;

  update queue_ops
     set ops = ops + p_ops
   where month = v_month
     and (ops + p_ops)::bigint * 100 <= p_monthly_limit::bigint * p_cutoff_pct
  returning ops into v_ops;

  return v_ops is not null;
end;
$$;

revoke execute on function queue_budget_take(integer, integer, integer) from public, anon, authenticated;
grant execute on function queue_budget_take(integer, integer, integer) to service_role;
