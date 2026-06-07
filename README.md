# nicola-agent-bridge

把 Telegram 群（NicolaAgentFamily）的消息桥接到本机 `claude` CLI，
让 cc 在群里以**完整开发能力**（读写本地项目文件、执行命令）工作。

```
TG 群  ──→  本服务(grammy)  ──→  claude -p (headless, 复用本机登录)  ──→  回贴群里
```

## 运行

```bash
cd ~/TSProjects/nicola-agent-bridge
npm install
npm start            # = node --env-file=.env src/index.js
```

## 使用

群里给 cc 发消息（三种触发方式任选）：

- `cc: 帮我看下 pet-adoption-app 的登录接口`
- `@你的机器人用户名 ...`
- 直接**回复** cc 的某条消息

命令（统一 cc 前缀，便于将来与 Codex 等其它 bot 共处一群不冲突）：

- `/ccnew` —— 开启新会话，清空上下文
- `/ccproject <路径>` —— 切换工作目录（按 chat 记忆，自动开新会话）；不带参数则显示当前目录
- `/ccwhoami` —— 查看自己的 user_id 和群的 chat_id（用于配置白名单）
- `/cchelp` —— 帮助

## 配置（.env）

| 变量 | 说明 |
|------|------|
| `BOT_TOKEN` | BotFather 给的 token |
| `ALLOWED_USER_IDS` | 允许触发 cc 的用户 ID，逗号分隔。**留空则不执行任何任务** |
| `WORK_DIR` | cc 的默认工作目录 |
| `MODEL` | opus / sonnet / haiku |
| `PERMISSION_MODE` | bypassPermissions(全自动) / acceptEdits / default |
| `TRIGGER` | 触发前缀，默认 `cc` |

## ⚠️ 安全须知

- `bypassPermissions` = 白名单用户能让 cc 在你 Mac 上**任意读写文件、执行命令**。
  务必只把**你自己**的 user_id 放进 `ALLOWED_USER_IDS`。
- token 泄露等于别人能控制你的 bot，切勿提交到 git（已在 `.gitignore`）。
- 会话 ID 存在 `data/sessions.json`（已忽略）。
