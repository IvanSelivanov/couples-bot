-- Схема бота. Источник: дизайн-док, раздел «Данные», и решения ревью
-- (R3, R10, R12, R13, R18, R19, R21, R22, R25, R26, R27, DR19, DR22).
--
-- Доступ: только service key с сервера. RLS включён на всех таблицах и
-- политик нет, поэтому anon/publishable ключ не видит ничего, даже если утечёт.
--
-- Текст лички (scope = 'dm', черновики, неодобренные заметки, сводки dm:*,
-- payload апдейтов из фолбэка) хранится шифротекстом из lib/crypto.js:
-- база его не читает и не разбирает.

create table couples (
  id                 bigint generated always as identity primary key,
  group_chat_id      bigint unique,
  -- Машина состояний пары (R6, R25): onboarding → active ⇄ paused,
  -- active/paused → revoked → paused|active, active → suspended → active.
  state              text not null default 'onboarding'
                     check (state in ('onboarding', 'active', 'paused', 'revoked', 'suspended')),
  -- Растёт на каждом переходе; can_publish сравнивает с ним (R12).
  state_version      integer not null default 0,
  auto_translate     boolean not null default true,
  -- Паузу снимает только поставивший (DR19); переживает /revoke (R25).
  paused_by          bigint,
  paused_at          timestamptz,
  pause_after_signal boolean not null default false,
  created_at         timestamptz not null default now()
);

create table members (
  user_id       bigint primary key,
  couple_id     bigint not null references couples (id) on delete cascade,
  lang          text,
  display_name  text,
  tz            text,
  consented_at  timestamptz,
  revoked_at    timestamptz,
  dm_started    boolean not null default false,
  created_at    timestamptz not null default now()
);
create index members_couple_idx on members (couple_id);

-- Окна разговора в группе (DR9; бывшие «сессии»). Одно открытое окно на пару
-- гарантирует частичный уникальный индекс (R21).
create table windows (
  id                 bigint generated always as identity primary key,
  couple_id          bigint not null references couples (id) on delete cascade,
  started_at         timestamptz not null default now(),
  last_message_at    timestamptz not null default now(),
  ended_at           timestamptz,
  -- id последнего сообщения, на которое ведущий уже отреагировал.
  answered_up_to     bigint not null default 0,
  -- Аренда права ответить (R2, R12).
  lease_id           uuid,
  generating_until   timestamptz,
  -- Когда в окне впервые опубликован ответ ведущего (DR23, R30).
  first_reply_at     timestamptz
);
create unique index windows_one_open_per_couple on windows (couple_id) where ended_at is null;

create table messages (
  id                bigint generated always as identity primary key,
  couple_id         bigint not null references couples (id) on delete cascade,
  scope             text not null check (scope in ('group', 'guest', 'dm')),
  owner_user_id     bigint,           -- владелец лички для scope = 'dm'
  author_user_id    bigint,           -- null у сообщений бота
  is_bot            boolean not null default false,
  kind              text not null default 'text' check (kind in ('text', 'voice', 'video_note')),
  tg_chat_id        bigint,
  tg_message_id     bigint,
  text              text,             -- для dm — шифротекст
  lang              text,
  -- Расшифровка голосовых (R22, R26): pending → done | failed, один раз.
  transcript_status text check (transcript_status in ('pending', 'done', 'failed')),
  transcript_late   boolean not null default false,
  created_at        timestamptz not null default now(),
  check (scope <> 'dm' or owner_user_id is not null),
  check (is_bot or author_user_id is not null)
);
-- Повтор того же апдейта не создаёт вторую строку (R3).
create unique index messages_tg_unique on messages (couple_id, scope, tg_chat_id, tg_message_id);
create index messages_couple_scope_idx on messages (couple_id, scope, id);
create index messages_dm_owner_idx on messages (owner_user_id, created_at) where scope = 'dm';

create table summaries (
  couple_id     bigint not null references couples (id) on delete cascade,
  scope_key     text not null,        -- 'group' или 'dm:<user_id>'
  text          text not null,        -- для dm:* — шифротекст
  covers_up_to  bigint not null default 0,
  updated_at    timestamptz not null default now(),
  primary key (couple_id, scope_key)
);

create table notes (
  id              bigint generated always as identity primary key,
  couple_id       bigint not null references couples (id) on delete cascade,
  author_user_id  bigint not null,
  text            text,               -- обнуляется при отзыве (R15)
  approved_at     timestamptz,
  revoked_at      timestamptz,
  created_at      timestamptz not null default now()
);

create table drafts (
  id            bigint generated always as identity primary key,
  couple_id     bigint not null references couples (id) on delete cascade,
  user_id       bigint not null,
  original      text,
  reformulated  text,
  translations  text,                 -- шифротекст JSON
  -- sending ставится условным UPDATE до отправки (R13).
  status        text not null default 'editing'
                check (status in ('editing', 'sending', 'unknown')),
  created_at    timestamptz not null default now()
);

create table abuse_flags (
  id          bigint generated always as identity primary key,
  couple_id   bigint not null references couples (id) on delete cascade,
  source      text not null,          -- 'group' или 'dm:<user_id>'
  set_at      timestamptz not null default now(),
  cleared_at  timestamptz             -- для 'group' в v1 никогда (DR20)
);
create index abuse_flags_active_idx on abuse_flags (couple_id) where cleared_at is null;

create table checks (
  id                bigint generated always as identity primary key,
  couple_id         bigint not null references couples (id) on delete cascade,
  speaker_user_id   bigint not null,
  listener_user_id  bigint not null,
  block_from        bigint not null,
  block_to          bigint not null,
  state             text not null,
  round             integer not null default 1,
  started_at        timestamptz not null default now(),
  ended_at          timestamptz
);

-- Дедупликация и долговечный приём (R3, R10, R19). payload заполняется
-- только в фолбэке без очереди, зашифрован и стирается при done (R27).
create table processed_updates (
  update_id    bigint primary key,
  status       text not null default 'received' check (status in ('received', 'done')),
  payload      text,
  received_at  timestamptz not null default now()
);

-- Исходящие сообщения (R13, R29). Строки лички удаляются после доставки (R27).
create table outbound (
  id              bigint generated always as identity primary key,
  couple_id       bigint references couples (id) on delete cascade,
  scope           text not null check (scope in ('group', 'guest', 'dm')),
  chat_id         bigint not null,
  window_id       bigint references windows (id) on delete set null,
  lease_id        uuid,
  part            integer not null default 0,
  status          text not null default 'pending' check (status in ('pending', 'sent', 'unknown')),
  payload         text not null,      -- для dm — шифротекст
  tg_message_id   bigint,
  created_at      timestamptz not null default now(),
  sent_at         timestamptz
);

-- Дневной счётчик запросов к Gemini (уровни квоты R20, R31).
create table quota (
  day       date primary key,
  requests  integer not null default 0
);

-- Месячный счётчик операций Vercel Queues (фолбэк R1).
create table queue_ops (
  month  date primary key,
  ops    integer not null default 0
);

-- Кеш машинного перевода фиксированных текстов (DR15, R23, TD1).
create table copy_cache (
  lang         text not null,
  key          text not null,
  text         text not null,
  source_hash  text not null,
  reviewed     boolean not null default false,
  stale        boolean not null default false,
  updated_at   timestamptz not null default now(),
  primary key (lang, key)
);

do $$
declare t text;
begin
  foreach t in array array[
    'couples', 'members', 'windows', 'messages', 'summaries', 'notes', 'drafts',
    'abuse_flags', 'checks', 'processed_updates', 'outbound', 'quota', 'queue_ops', 'copy_cache'
  ] loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;
