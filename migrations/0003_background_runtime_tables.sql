CREATE TABLE IF NOT EXISTS runtime_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS background_devices (
  device_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS background_snapshots (
  device_id TEXT PRIMARY KEY,
  snapshot_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS background_ai_keys (
  device_id TEXT PRIMARY KEY,
  encrypted_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  device_id TEXT PRIMARY KEY,
  subscription_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS background_pending_messages (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  role_id TEXT,
  message_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS background_runtime_states (
  device_id TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS background_activities (
  device_id TEXT PRIMARY KEY,
  state TEXT,
  foreground_until INTEGER DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_background_devices_updated_at
  ON background_devices (updated_at);

CREATE INDEX IF NOT EXISTS idx_background_pending_device_created_at
  ON background_pending_messages (device_id, created_at);
