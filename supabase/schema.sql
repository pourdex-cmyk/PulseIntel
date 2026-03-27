-- ═══════════════════════════════════════════════════════════════
-- PULSE INTELLIGENCE — SUPABASE SCHEMA
-- Run this entire file in Supabase → SQL Editor → New query
-- ═══════════════════════════════════════════════════════════════

-- Enable UUID extension (usually already enabled)
create extension if not exists "uuid-ossp";

-- ── PROFILES ─────────────────────────────────────────────────
-- Extends Supabase Auth users with app-specific profile data
create table if not exists profiles (
  id              uuid references auth.users on delete cascade primary key,
  first_name      text default '',
  last_name       text default '',
  title           text default '',
  company         text default '',
  signoff         text default '',
  style_notes     text default '',
  tone            text default 'professional'
                  check (tone in ('professional','friendly','direct','formal')),
  model           text default 'claude-sonnet-4-20250514',
  draft_length    text default 'medium'
                  check (draft_length in ('short','medium','long')),
  auto_analyze    text default 'on'
                  check (auto_analyze in ('on','priority','off')),
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

-- ── USER SETTINGS (connector tokens, Claude key) ─────────────
create table if not exists user_settings (
  user_id              uuid references auth.users on delete cascade primary key,
  claude_key_encrypted text,
  teams_token          text,
  slack_token          text,
  outlook_token        text,
  gmail_token          text,
  -- Webhook user identifiers (short hash of user_id for URL safety)
  -- Note: gmail_uid is repurposed to store the user's Gmail address after OAuth connect
  teams_uid            text unique,
  slack_uid            text unique,
  outlook_uid          text unique,
  gmail_uid            text unique,
  updated_at           timestamptz default now()
);


-- ── MESSAGES ─────────────────────────────────────────────────
create table if not exists messages (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references auth.users on delete cascade not null,
  source       text not null check (source in ('outlook','gmail','teams','slack')),
  type         text not null check (type in ('email','message','channel')),
  sender       text not null default '',
  handle       text not null default '',
  subject      text not null default '',
  preview      text default '',
  body         text default '',
  tags         jsonb default '[]',
  category     text default 'fyi'
               check (category in ('action','meeting','fyi','noise','archived')),
  priority     integer default 50 check (priority between 1 and 100),
  channel      text,
  unread       boolean default true,
  received_at  timestamptz default now(),
  created_at   timestamptz default now()
);

-- Index for fast feed queries
create index if not exists idx_messages_user_source
  on messages (user_id, source, received_at desc);
create index if not exists idx_messages_user_category
  on messages (user_id, category, priority desc);
create index if not exists idx_messages_unread
  on messages (user_id, unread) where unread = true;

-- ── MEETINGS ─────────────────────────────────────────────────
create table if not exists meetings (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid references auth.users on delete cascade not null,
  title            text not null,
  platform         text default 'teams'
                   check (platform in ('teams','zoom','gmeet','inperson','phone')),
  date             date,
  time             text,   -- stored as "HH:MM" string
  duration         text default '1 hr',
  link             text,
  attendees        jsonb default '[]',
  agenda           jsonb default '[]',
  needs            jsonb default '[]',
  notes            text default '',
  related_msg_ids  jsonb default '[]',
  ai_prep          text default '',
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);

create index if not exists idx_meetings_user_date
  on meetings (user_id, date asc);

-- ── ROW LEVEL SECURITY ────────────────────────────────────────
-- Users can only access their own data

alter table profiles      enable row level security;
alter table user_settings enable row level security;
alter table messages      enable row level security;
alter table meetings      enable row level security;

-- Profiles
create policy "Users read own profile"
  on profiles for select using (auth.uid() = id);
create policy "Users update own profile"
  on profiles for update using (auth.uid() = id);
create policy "Users insert own profile"
  on profiles for insert with check (auth.uid() = id);

-- User settings
create policy "Users read own settings"
  on user_settings for select using (auth.uid() = user_id);
create policy "Users upsert own settings"
  on user_settings for all using (auth.uid() = user_id);

-- Messages
create policy "Users read own messages"
  on messages for select using (auth.uid() = user_id);
create policy "Users update own messages"
  on messages for update using (auth.uid() = user_id);
create policy "Users delete own messages"
  on messages for delete using (auth.uid() = user_id);
-- Service role (webhooks) can insert
create policy "Service can insert messages"
  on messages for insert with check (true);

-- Meetings
create policy "Users full access to own meetings"
  on meetings for all using (auth.uid() = user_id);

-- ── TRIGGER: auto-create profile on signup ────────────────────
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer
as $$
declare
  uid_short text;
begin
  -- Create profile
  insert into public.profiles (id, first_name, last_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'first_name', ''),
    coalesce(new.raw_user_meta_data->>'last_name', '')
  )
  on conflict (id) do nothing;

  -- Create settings with unique webhook UIDs
  uid_short := substring(replace(new.id::text, '-', ''), 1, 12);
  insert into public.user_settings (
    user_id, teams_uid, slack_uid, outlook_uid, gmail_uid
  )
  values (
    new.id,
    'teams-'   || uid_short,
    'slack-'   || uid_short,
    'outlook-' || uid_short,
    'gmail-'   || uid_short
  )
  on conflict (user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── TRIGGER: update updated_at timestamps ─────────────────────
create or replace function update_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

create trigger profiles_updated_at
  before update on profiles
  for each row execute function update_updated_at();
create trigger meetings_updated_at
  before update on meetings
  for each row execute function update_updated_at();
create trigger settings_updated_at
  before update on user_settings
  for each row execute function update_updated_at();
