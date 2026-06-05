DROP INDEX IF EXISTS idx_wechat_outbox_idempotency_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_wechat_outbox_idempotency_key
  ON wechat_outbox_messages (idempotency_key);
