-- Месячный бюджет операций Vercel Queues (R1). На Hobby первый 1 000 000
-- операций в месяц бесплатен; превышение лимита Hobby ставит проект на паузу
-- до конца 30 дней. Поэтому при 90% бот сам переходит на фолбэк без очереди.
--
-- Одно сообщение ≈ 3 операции (send + доставка + подтверждение). Решение и
-- инкремент атомарны, как у quota_take.

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
