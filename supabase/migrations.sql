-- Run this in Supabase → SQL Editor
-- Safe to run multiple times (uses IF NOT EXISTS and ADD COLUMN IF NOT EXISTS)

-- 1. oauth_tokens table (replaces old token columns in user_settings)
CREATE TABLE IF NOT EXISTS oauth_tokens (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      TEXT        NOT NULL,
  scope         TEXT        NOT NULL,
  access_token  TEXT        NOT NULL,
  refresh_token TEXT,
  expires_at    TIMESTAMPTZ NOT NULL,
  raw_email     TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, provider, scope)
);

-- 2. messages table extensions
ALTER TABLE messages ADD COLUMN IF NOT EXISTS external_id      TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS from_name        TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS from_email       TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS body_preview     TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_read          BOOLEAN DEFAULT false;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS importance       TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS has_attachments  BOOLEAN DEFAULT false;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS raw_json         JSONB;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS ai_priority      TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS ai_category      TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS ai_summary       TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS ai_action        TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS phishing_flags   JSONB DEFAULT '[]';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS draft_reply      TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS triaged_at       TIMESTAMPTZ;

-- Unique constraint so re-sync never duplicates
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'messages_user_source_ext_uniq'
  ) THEN
    ALTER TABLE messages ADD CONSTRAINT messages_user_source_ext_uniq
      UNIQUE (user_id, source, external_id);
  END IF;
END $$;

-- 3. meetings table extensions
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS source       TEXT;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS external_id  TEXT;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS start_time   TIMESTAMPTZ;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS end_time     TIMESTAMPTZ;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS organizer    TEXT;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS join_url     TEXT;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS raw_json     JSONB;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS ai_brief     TEXT;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS ai_agenda    TEXT;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS ai_deck      JSONB;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS ai_summary   TEXT;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS transcript   TEXT;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS action_items JSONB DEFAULT '[]';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'meetings_user_source_ext_uniq'
  ) THEN
    ALTER TABLE meetings ADD CONSTRAINT meetings_user_source_ext_uniq
      UNIQUE (user_id, source, external_id);
  END IF;
END $$;
