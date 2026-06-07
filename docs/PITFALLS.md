# 踩坑总结：把 Claude/Agent 接进 Telegram 群（macOS + 中国网络环境）

> 背景：在 macOS（Apple Silicon）上搭一个桥接服务，把 Telegram 群消息转发给本机 `claude` CLI（headless 模式），让 AI 以**完整开发能力**（读写本地文件、执行命令）在群里工作。技术栈：Node ESM + grammy。
> 本文是从 0 到 1 跑通过程中实际踩到的坑，供 Codex 接同类任务时参考。

---

## 一、概念 / 架构

**坑 1：AI 不能"自己加入"群。**
- 现象：以为让 cc/Codex "进群" 是个开关。
- 实质：CLI Agent 没有 Telegram 身份，必须搭桥：`TG 群 ↔ Bot 中间服务 ↔ claude CLI`。这是一个要开发的小项目。
- 结论：先想清楚要"真·CLI 能力（能读写本地文件）"还是"纯云端聊天"。前者必须服务跑在本机。

**坑 2：复用本机登录，别另配 API key。**
- `claude` CLI 的 headless 模式可直接复用本机 Claude Code 登录，**无需 ANTHROPIC_API_KEY、不额外计费**，且天然有完整工具权限。
- 调用范式（已验证）：
  ```bash
  claude -p --output-format json --resume <session_id> \
         --permission-mode bypassPermissions --model opus
  ```
  prompt 通过 **stdin** 传入（不要拼到命令行参数里，避免转义/长度问题）。
- 返回是一行 JSON，取 `result`（回复文本）和 `session_id`（用于下次 `--resume` 续接）。`is_error`、`permission_denials` 可用于判断异常。

---

## 二、网络与代理（中国环境，最容易卡住）

**坑 3：访问 Telegram 必须走代理，且"直连偶尔通"具有极强迷惑性。**
- 现象：`curl` 直连 `api.telegram.org` 偶尔能拿到数据，但 Node 进程连各 IP 不是 `ECONNREFUSED` 就是 `ETIMEDOUT`。
- 原因：Telegram 多 IP，部分被墙；curl 那次只是恰好命中一个临时可用 IP，不可靠。
- 结论：**别依赖直连**，老老实实走代理。

**坑 4：先搞清楚代理客户端实际监听哪个端口，别想当然。**
- 现象：按"常识"用了 ClashX 的 `7890`，结果代理根本没在那个端口。
- 真相：用户实际用的是 **FlyingBird-Lite**，HTTP 代理监听 **`7892`**（不是 7890）。
- 排查方法：
  ```bash
  lsof -nP -iTCP -sTCP:LISTEN | grep 127.0.0.1   # 看谁在监听
  curl -x http://127.0.0.1:7892 https://api.telegram.org/...   # 测 HTTP 代理
  curl -x socks5://127.0.0.1:7892 ...                          # 测 SOCKS5
  ```
- 教训：代理端口/类型（HTTP vs SOCKS5）务必实测确认，不要照搬默认值。

**坑 5：grammy 要显式走代理。**
- grammy 底层用 node-fetch，给它配 agent：
  ```js
  const agent = url.startsWith('socks') ? new SocksProxyAgent(url) : new HttpsProxyAgent(url);
  new Bot(token, { client: { baseFetchConfig: { agent } } });
  ```

---

## 三、launchd 常驻环境（本项目最大的坑，吃了两次亏）

> 根因一句话：**launchd 启动的进程，环境比终端"干净"得多——PATH 极简、没有 shell 里的代理变量。所有"终端能跑、托管就崩"的问题都出在这。**

**坑 6：`spawn claude` 报 `ENOENT`（找不到 claude）。**
- 原因：launchd 的 PATH 只有 `/usr/bin:/bin` 之类，不含 nvm 的 bin 目录（claude 软链在那）。
- 解决：spawn 子进程时显式补 PATH。用 `dirname(process.execPath)` 推导出"启动本服务的 node 所在目录"（claude 也在那），再加 Homebrew 目录：
  ```js
  const NODE_BIN_DIR = dirname(process.execPath);
  childEnv.PATH = `${NODE_BIN_DIR}:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}`;
  ```
  好处：不写死 node 版本号，node 升级也不会坏。

**坑 7：claude 调 Anthropic API 报 `403 "Request not allowed"`。**
- 现象：终端里 `claude -p` 正常，一放到 launchd 托管就 403。返回里 `inference_geo` 为空。
- 原因：**这是地域限制（中国 IP 被拦），不是密钥失效。** 终端 shell 自带 `http_proxy/https_proxy` 变量，claude 走了代理；launchd 进程没有这些变量 → 直连 → 被 Anthropic 按地域 403。
- 解决：spawn claude 时把代理变量也注入子进程：
  ```js
  childEnv.HTTPS_PROXY = childEnv.HTTP_PROXY = PROXY_URL;
  childEnv.https_proxy = childEnv.http_proxy = PROXY_URL;
  ```
- 辨别技巧：**403 + `inference_geo` 为空 = 地域拦截（缺代理）**，不要误判成 auth 问题去折腾密钥。

**坑 8：plist 里 node 路径硬编码的隐患。**
- LaunchAgent plist 的 `ProgramArguments` 写死了 `.../node/v25.9.0/bin/node`。node 大版本升级后路径变，服务会起不来，需同步改 plist。

**launchd 配置要点（顺带记下）：**
- `RunAtLoad=true`（登录自启）+ `KeepAlive=true`（崩溃自动重拉）+ `ThrottleInterval=30`（崩溃后至少隔 30s 再起，避免代理没就绪时疯狂重启循环）。
- 重启服务：`launchctl kickstart -k gui/$(id -u)/<label>`。
- LaunchAgent 只在**用户登录后**才起；它依赖的代理客户端若不在登录项里，重启电脑后需手动开代理——但因为 KeepAlive，代理一开服务会在 30s 内自愈，无需手动重启服务。

---

## 四、Telegram Bot 设计

**坑 9：隐私模式会让 bot 读不到群里普通消息。**
- BotFather → `/setprivacy` → **Disable**，否则 bot 只能收到命令和 @ 自己的消息。
- 验证：`getMe` 返回里看 `can_read_all_group_messages: true`。

**坑 10：多个 bot 同群时，斜杠命令会"广播"冲突。**
- 现象：`/new` 这种命令群里所有 bot 都会收到。cc 和 Codex 同群时 `/new` 会撞车。
- 解决：**命令加命名空间前缀**。cc 用 `/ccnew` `/ccproject` `/ccwhoami`；Codex 建议用 `/cxnew` 这类。Telegram 原生的 `/cmd@botname` 也能消歧但要每次打 @，体验差。
- 普通指令（prompt）用文本前缀天然隔离：cc 用 `cc:`，Codex 用 `codex:`。

**坑 11：触发词判断别只认冒号。**
- 现象：只匹配 `cc:` / `cc：`，用户打中文逗号 `cc，你好` 就不触发。
- 解决：判定为"以 `cc` 开头 **且** 紧跟的不是拉丁字母/数字"即触发，然后剥掉开头的标点/空格。
  - ✅ 触发：`cc: x`、`cc，x`、`cc x`、`cc你好`
  - ❌ 不触发：`ccache`、`ccleaner`（避免误伤英文词）、`codex: x`（不抢别人消息）

**坑 12：opus 冷启动慢，要给即时反馈。**
- 现象：新会话冷启动十几~几十秒，群里只有"正在输入"不明显，用户以为没反应会重复发。
- 解决：收到消息**立刻回一条占位**（如"🐾 收到，处理中…"），出结果后删掉占位再发正文。

**坑 12.5：带附件的消息，文字在 `caption` 里，不在 `text` 里。**
- 现象：用户发一个文档/图片 + 一段 @bot 的说明，bot 完全没反应。
- 原因：① 只监听了 `message:text`，文档消息不触发；② 附带文字在 `ctx.message.caption`，不在 `ctx.message.text`。
- 解决：触发判断取 `msg.text ?? msg.caption`；另外监听 `message:document`/`message:photo`。
- 处理附件：`ctx.api.getFile(file_id)` 拿到 `file_path` → 从 `https://api.telegram.org/file/bot<token>/<file_path>` **经同一个代理 agent** 下载到本机 → 把**本地绝对路径**写进给 claude 的 prompt 让它读。`.docx` 等非纯文本，claude 用 `textutil -convert txt` 等自行转换（claude 有 bash）。

**其它实现细节：**
- Telegram 单条消息上限 4096 字，长回复要**按行分段**发送。
- 每个 chat 维护独立 `session_id`（持久化到文件），用 `--resume` 续接；同一会话加**忙碌锁**避免并发 resume 竞争（不过 grammy 默认是顺序处理 update 的）。
- 每个 chat 可独立切**工作目录**和**模型**（持久化到文件）。模型用别名 `opus/sonnet/haiku` 会自动指向各档最新模型，模型更新时通常无需手动改。

---

## 五、安全

**坑 13：`bypassPermissions` = 把本机交出去，必须配白名单。**
- 全自动模式下，群里任何能触发 bot 的人都能在你 Mac 上**任意读写文件、执行命令**。
- 必须做**发送者 user_id 白名单**，只放自己；非白名单静默忽略。
- bot token 泄露 = 别人能控制你的 bot，**绝不能进 git**。

---

## 六、Git 提交

**坑 14：子目录其实在父级仓库里，直接提交会把一堆无关项目带上去。**
- 现象：项目目录 `git status` 里冒出 `../其它项目/` 的文件。
- 原因：父目录（如 `~/TSProjects`）本身是个 git 仓库，子项目只是它的子目录。
- 排查：`git rev-parse --show-toplevel` 看仓库根到底在哪。
- 解决：在子项目里单独 `git init` 建独立仓库，只提交本项目。

**坑 15：推送前务必确认敏感文件没被跟踪。**
- `.gitignore` 要挡住 `.env`、`data/`（会话/日志）、`node_modules/`。
- 提交前自查：
  ```bash
  git ls-files | grep -E "\.env$|sessions\.json|node_modules"   # 应为空
  ```
- SSH 推送：若 `ssh-add -l` 显示 key 已加载、`ssh -T -o BatchMode=yes git@github.com` 能认证，则无需交互输 passphrase。

---

## 速查：所有"终端能跑、托管就崩"的根因

| 现象 | 根因 | 解决 |
|------|------|------|
| `spawn claude ENOENT` | launchd PATH 不含 nvm 目录 | childEnv 补 PATH（`dirname(process.execPath)`）|
| `claude` 返回 403 / `inference_geo` 空 | launchd 无代理变量 → 地域拦截 | childEnv 注入 `HTTPS_PROXY/HTTP_PROXY` |
| grammy 连不上 Telegram | 直连被墙 / 没走代理 | baseFetchConfig.agent 走代理 |
| 重启后服务连不上 | 代理客户端没自启 | KeepAlive 自愈，或把代理加登录项 |
