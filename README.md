# 小手机个人 Cloudflare 后台

这是小手机的 BYO Cloudflare Runtime 模板。部署后，后台属于用户自己的 Cloudflare 账号，D1 数据和 Worker Secret 都不进入小手机作者的托管服务器。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/yutuyue2-jpg/aa-phone-personal-runtime-template)

## 一键配置流程

1. 在小手机设置页打开“个人云端后台”。
2. 点击“生成连接码”。
3. 点击“打开 Cloudflare 部署”，登录 Cloudflare。
4. 在部署页把连接码填入 `SETUP_SECRET`。
5. 部署完成后，把 Worker URL 回填到小手机。
6. 点击“测试并绑定”。

## 自动安全配置

- 首次 `npm run deploy` 时，模板会自动检查并补齐 `WECHAT_ILINK_STATE_SECRET`，用户不需要理解或手填这个值。
- 同一轮部署还会自动补齐 `PERSONAL_RUNTIME_DATA_SECRET`，用于把后台 AI key 加密后再写入 D1，而不是明文落库。
- 只有本地 `wrangler dev` 调试时，才需要自己在 `.dev.vars` 里准备这两个随机 secret。

## 已支持接口

- `GET /cloud/health`
- `POST /setup/claim`
- `POST /chat/send`
- `GET /messages/sync?since=...`
- `POST /messages/ack`
- `POST /cloud/disconnect`
- `GET /vapidPublicKey`
- `POST /subscribe`
- `POST /background-ai-key`
- `DELETE /background-ai-key`
- `POST /snapshot`
- `POST /activity`
- `GET /pull?deviceId=...`
- `POST /ack`
- `POST /push-receipt`
- `GET /debug/status?deviceId=...`
- `POST /debug/run`
- `POST /wechat/login/start`
- `GET /wechat/login/status?sessionId=...`
- `POST /wechat/sync-now`
- `POST /wechat/outbox/enqueue`
- `POST /wechat/thread-context`
- `POST /wechat/config`
- `GET /wechat/daemon/health`
- `POST /wechat/daemon/tick`

## 数据

使用 D1 保存：

- `users`
- `roles`
- `conversations`
- `messages`
- `runtime_settings`
- `background_devices`
- `background_snapshots`
- `background_ai_keys`
- `push_subscriptions`
- `background_pending_messages`
- `background_runtime_states`
- `background_activities`
- `wechat_daemon_bindings`
- `wechat_thread_contexts`
- `wechat_outbox_messages`

后台主动消息、Web Push pending 队列、投递回执、微信 Bridge 代理、微信 outbox 和 daemon 轮询已经收口到这个个人 Runtime。图片/语音/表情等媒体投递会在后续阶段继续增强。
