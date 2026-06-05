CREATE TABLE IF NOT EXISTS wechat_daemon_bindings (
  thread_key TEXT PRIMARY KEY,
  role_id TEXT,
  account_id TEXT,
  identity TEXT,
  chat_id TEXT,
  wechat_reply_triggers_ai INTEGER DEFAULT 1,
  pwa_chat_to_wechat INTEGER DEFAULT 0,
  quiet_seconds INTEGER DEFAULT 0,
  status TEXT,
  bridge_type TEXT,
  bridge_url TEXT,
  binding_id TEXT,
  remote_binding_id TEXT,
  session_id TEXT,
  external_account_id TEXT,
  external_account_name TEXT,
  last_error TEXT,
  last_login_started_at INTEGER DEFAULT 0,
  last_status_checked_at INTEGER DEFAULT 0,
  last_synced_at INTEGER DEFAULT 0,
  last_sent_at INTEGER DEFAULT 0,
  last_inbound_at INTEGER DEFAULT 0,
  last_inbound_from TEXT,
  last_inbound_context_token TEXT,
  quiet_until_at INTEGER DEFAULT 0,
  auto_reply_state TEXT,
  last_auto_reply_ready_at INTEGER DEFAULT 0,
  last_auto_reply_started_at INTEGER DEFAULT 0,
  last_auto_reply_queued_at INTEGER DEFAULT 0,
  last_auto_reply_completed_at INTEGER DEFAULT 0,
  next_auto_reply_attempt_at INTEGER DEFAULT 0,
  auto_reply_attempt_count INTEGER DEFAULT 0,
  auto_reply_last_error TEXT,
  thread_context_updated_at INTEGER DEFAULT 0,
  recent_inbound_updates_json TEXT,
  pending_inbound_updates_json TEXT,
  pending_inbound_count INTEGER DEFAULT 0,
  processing_inbound_updates_json TEXT,
  processing_inbound_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS wechat_thread_contexts (
  thread_key TEXT PRIMARY KEY,
  snapshot_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS wechat_outbox_messages (
  id TEXT PRIMARY KEY,
  thread_key TEXT,
  role_id TEXT,
  account_id TEXT,
  identity TEXT,
  chat_id TEXT,
  to_user TEXT,
  type TEXT,
  content TEXT,
  media_url TEXT,
  media_mime TEXT,
  caption TEXT,
  context_token TEXT,
  source TEXT,
  status TEXT,
  binding_id TEXT,
  remote_binding_id TEXT,
  client_message_id TEXT,
  idempotency_key TEXT NOT NULL,
  message_id TEXT,
  last_error TEXT,
  attempt_count INTEGER DEFAULT 0,
  next_attempt_at INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  sent_at INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_wechat_daemon_bindings_updated_at
  ON wechat_daemon_bindings (updated_at);

CREATE INDEX IF NOT EXISTS idx_wechat_outbox_pending
  ON wechat_outbox_messages (status, next_attempt_at, created_at);

CREATE INDEX IF NOT EXISTS idx_wechat_outbox_thread
  ON wechat_outbox_messages (thread_key, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_wechat_outbox_idempotency_key
  ON wechat_outbox_messages (idempotency_key);
