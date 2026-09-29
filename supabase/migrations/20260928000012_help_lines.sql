-- Help-line numbers by country (DR21; decided 2026-09-28: "ahead of time,
-- with a cache"). The crisis branch reads only this cache and the static
-- fallback; no model is needed during a crisis.
--
-- lines: [{ kind, name, phone, source_url }], verified only: the number's digits
-- were found on the source_url page when it was loaded.

alter table members add column country text;  -- ISO 3166-1 alpha-2

create table help_lines (
  country     text primary key,
  lines       jsonb not null default '[]'::jsonb,
  fetched_at  timestamptz not null default now(),
  status      text not null default 'ok' check (status in ('ok', 'failed'))
);

alter table help_lines enable row level security;
