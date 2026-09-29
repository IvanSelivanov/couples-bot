-- Bot schema. Source: the design doc, section "Data", and review decisions
-- (R3, R10, R12, R13, R18, R19, R21, R22, R25, R26, R27, DR19, DR22).
--
-- Access: service key from the server only. RLS is enabled on every table with
-- no policies, so the anon/publishable key sees nothing, even if it leaks.
--
-- Private chat text (scope = 'dm', drafts, unapproved notes, dm:* summaries,
-- update payloads from the fallback) is stored as ciphertext from lib/crypto.js:
-- the database neither reads nor parses it.

create table couples (
  id                 bigint generated always as identity primary key,
  group_chat_id      bigint unique,
  -- Couple state machine (R6, R25): onboarding → active ⇄ paused,
  -- active/paused → revoked → paused|active, active → suspended → active.
  state              text not null default 'onboarding'
                     check (state in ('onboarding', 'active', 'paused', 'revoked', 'suspended')),
  -- Grows on every transition; can_publish compares against it (R12).
  state_version      integer not null default 0,
  auto_translate     boolean not null default true,
  -- Only the person who paused can resume (DR19); survives /revoke (R25).
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

-- Conversation windows in the group (DR9; formerly "sessions"). One open window per
-- couple is guaranteed by a partial unique index (R21).
create table windows (
  id                 bigint generated always as identity primary key,
  couple_id          bigint not null references couples (id) on delete cascade,
  started_at         timestamptz not null default now(),
  last_message_at    timestamptz not null default now(),
  ended_at           timestamptz,
  -- id of the last message the helper has already responded to.
  answered_up_to     bigint not null default 0,
  -- Lease on the right to reply (R2, R12).
  lease_id           uuid,
  generating_until   timestamptz,
  -- When the helper's reply was first published in the window (DR23, R30).
  first_reply_at     timestamptz
);
create unique index windows_one_open_per_couple on windows (couple_id) where ended_at is null;

create table messages (
  id                bigint generated always as identity primary key,
  couple_id         bigint not null references couples (id) on delete cascade,
  scope             text not null check (scope in ('group', 'guest', 'dm')),
  owner_user_id     bigint,           -- private chat owner for scope = 'dm'
  author_user_id    bigint,           -- null for bot messages
  is_bot            boolean not null default false,
  kind              text not null default 'text' check (kind in ('text', 'voice', 'video_note')),
  tg_chat_id        bigint,
  tg_message_id     bigint,
  text              text,             -- ciphertext for dm
  lang              text,
  -- Voice transcription (R22, R26): pending → done | failed, exactly once.
  transcript_status text check (transcript_status in ('pending', 'done', 'failed')),
  transcript_late   boolean not null default false,
  created_at        timestamptz not null default now(),
  check (scope <> 'dm' or owner_user_id is not null),
  check (is_bot or author_user_id is not null)
);
-- A repeat of the same update doesn't create a second row (R3).
create unique index messages_tg_unique on messages (couple_id, scope, tg_chat_id, tg_message_id);
create index messages_couple_scope_idx on messages (couple_id, scope, id);
create index messages_dm_owner_idx on messages (owner_user_id, created_at) where scope = 'dm';

create table summaries (
  couple_id     bigint not null references couples (id) on delete cascade,
  scope_key     text not null,        -- 'group' or 'dm:<user_id>'
  text          text not null,        -- ciphertext for dm:*
  covers_up_to  bigint not null default 0,
  updated_at    timestamptz not null default now(),
  primary key (couple_id, scope_key)
);

create table notes (
  id              bigint generated always as identity primary key,
  couple_id       bigint not null references couples (id) on delete cascade,
  author_user_id  bigint not null,
  text            text,               -- nulled on revocation (R15)
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
  translations  text,                 -- ciphertext of JSON
  -- sending is set by a conditional UPDATE before sending (R13).
  status        text not null default 'editing'
                check (status in ('editing', 'sending', 'unknown')),
  created_at    timestamptz not null default now()
);

create table abuse_flags (
  id          bigint generated always as identity primary key,
  couple_id   bigint not null references couples (id) on delete cascade,
  source      text not null,          -- 'group' or 'dm:<user_id>'
  set_at      timestamptz not null default now(),
  cleared_at  timestamptz             -- never for 'group' in v1 (DR20)
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

-- Deduplication and durable intake (R3, R10, R19). payload is filled only in
-- the fallback without the queue, encrypted, and wiped on done (R27).
create table processed_updates (
  update_id    bigint primary key,
  status       text not null default 'received' check (status in ('received', 'done')),
  payload      text,
  received_at  timestamptz not null default now()
);

-- Outgoing messages (R13, R29). Private chat rows are deleted after delivery (R27).
create table outbound (
  id              bigint generated always as identity primary key,
  couple_id       bigint references couples (id) on delete cascade,
  scope           text not null check (scope in ('group', 'guest', 'dm')),
  chat_id         bigint not null,
  window_id       bigint references windows (id) on delete set null,
  lease_id        uuid,
  part            integer not null default 0,
  status          text not null default 'pending' check (status in ('pending', 'sent', 'unknown')),
  payload         text not null,      -- ciphertext for dm
  tg_message_id   bigint,
  created_at      timestamptz not null default now(),
  sent_at         timestamptz
);

-- Daily Gemini request counter (quota tiers R20, R31).
create table quota (
  day       date primary key,
  requests  integer not null default 0
);

-- Monthly Vercel Queues operations counter (R1 fallback).
create table queue_ops (
  month  date primary key,
  ops    integer not null default 0
);

-- Machine translation cache for fixed texts (DR15, R23, TD1).
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
