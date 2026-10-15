-- Gateway state. Migrations are expand-only so an older image can run against a newer schema.
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  name          text NOT NULL DEFAULT '',
  role          text NOT NULL CHECK (role IN ('admin', 'member')),
  password_hash text NOT NULL,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE invites (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL,
  role        text NOT NULL CHECK (role IN ('admin', 'member')),
  token_hash  text NOT NULL UNIQUE,
  created_by  uuid REFERENCES users ON DELETE SET NULL,
  expires_at  timestamptz NOT NULL,
  accepted_at timestamptz
);

CREATE TABLE api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  name         text NOT NULL,
  prefix       text NOT NULL UNIQUE,          -- public part, used for lookup
  key_hash     text NOT NULL,                 -- sha256(full key)
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

CREATE TABLE servers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug             text NOT NULL UNIQUE CHECK (slug ~ '^[a-z][a-z0-9-]{1,30}$'),  -- immutable: it prefixes tool names
  name             text NOT NULL,
  url              text NOT NULL,
  auth_type        text NOT NULL DEFAULT 'none' CHECK (auth_type IN ('none', 'bearer', 'header')),
  auth_header_name text,
  credential_enc   text,                      -- AES-256-GCM, never returned by the API
  enabled          boolean NOT NULL DEFAULT true,
  timeout_ms       integer NOT NULL DEFAULT 15000 CHECK (timeout_ms BETWEEN 1000 AND 120000),
  status           text NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown', 'connected', 'unreachable')),
  last_error       text,
  last_checked_at  timestamptz,
  tools            jsonb NOT NULL DEFAULT '[]',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  user_id     uuid,                           -- no FK: audit outlives users
  user_email  text,
  api_key_id  uuid,
  source      text NOT NULL CHECK (source IN ('mcp', 'chat')),
  server_slug text,
  tool_name   text,
  duration_ms integer NOT NULL DEFAULT 0,
  outcome     text NOT NULL CHECK (outcome IN ('ok', 'error', 'timeout', 'unreachable', 'denied')),
  error       text
);
CREATE INDEX audit_log_at ON audit_log (at DESC);
CREATE INDEX audit_log_user_at ON audit_log (user_id, at DESC);
