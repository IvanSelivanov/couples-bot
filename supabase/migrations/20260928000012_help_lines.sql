-- Номера помощи по странам (DR21; решение пользователя 2026-09-28: «заранее,
-- с кешем»). Кризисная ветка читает только этот кеш и статический запасной
-- вариант — модель в момент кризиса не нужна.
--
-- lines: [{ kind, name, phone, source_url }] — только проверенные: цифры
-- номера найдены на странице source_url при загрузке.

alter table members add column country text;  -- ISO 3166-1 alpha-2

create table help_lines (
  country     text primary key,
  lines       jsonb not null default '[]'::jsonb,
  fetched_at  timestamptz not null default now(),
  status      text not null default 'ok' check (status in ('ok', 'failed'))
);

alter table help_lines enable row level security;
