CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  owner_token_hash TEXT,
  setup_claimed_at INTEGER,
  last_ack_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  profile_json TEXT NOT NULL,
  cloud_enabled INTEGER DEFAULT 1,
  wechat_enabled INTEGER DEFAULT 0,
  active_message_enabled INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  channel_scope TEXT DEFAULT 'unified',
  last_message_id TEXT,
  last_message_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  content TEXT NOT NULL,
  content_type TEXT DEFAULT 'text',
  source TEXT NOT NULL,
  external_wechat_message_id TEXT,
  delivery_json TEXT,
  meta_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_user_created_at ON messages (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_created_at ON messages (conversation_id, created_at);
