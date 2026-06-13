import { Bot, InputFile } from 'grammy';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { createWriteStream, mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import { config } from './config.js';
import {
  askClaude,
  resetSession,
  isBusy,
  getWorkDir,
  setWorkDir,
  getModel,
  setModel,
  compactSession,
} from './claude.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOWNLOAD_DIR = join(__dirname, '..', 'data', 'downloads');

// 如配置了代理，grammy 经代理访问 Telegram（国内必需）；下载文件也复用这个 agent
let proxyAgent;
let botOptions;
if (config.proxyUrl) {
  proxyAgent = config.proxyUrl.startsWith('socks')
    ? new SocksProxyAgent(config.proxyUrl)
    : new HttpsProxyAgent(config.proxyUrl);
  botOptions = { client: { baseFetchConfig: { agent: proxyAgent } } };
  console.log(`[bot] 经代理访问 Telegram: ${config.proxyUrl}`);
}

export const bot = new Bot(config.botToken, botOptions);

let botUsername = '';
bot.api.getMe().then((me) => {
  botUsername = me.username;
  console.log(`[bot] 已登录为 @${botUsername} (id=${me.id})`);
});

// 注册 / 命令菜单（打 / 时自动补全）
bot.api
  .setMyCommands([
    { command: 'ccnew', description: '清空上下文、开新会话' },
    { command: 'cccompact', description: '压缩上下文（生成摘要、省 token）' },
    { command: 'ccproject', description: '切换工作目录（自动开新会话）' },
    { command: 'ccmodel', description: '切换模型 opus/sonnet/haiku' },
    { command: 'ccwhoami', description: '查看你的 ID' },
    { command: 'cchelp', description: '帮助' },
  ])
  .catch((e) => console.error('[bot] 注册命令菜单失败:', e.message));

// 判断这条消息是否在对 cc 说话，并返回去掉触发词后的纯 prompt；不是则返回 null
function extractPrompt(ctx) {
  const msg = ctx.message;
  if (!msg) return null;
  // 带附件的消息文字在 caption 里，不在 text 里
  const text = (msg.text ?? msg.caption ?? '').trim();
  const lower = text.toLowerCase();

  // 1) 以 cc 开头即视为在叫 cc：cc: / cc： / cc， / cc 空格 / cc直接接中文 都行。
  //    但后面紧跟拉丁字母/数字的不算（避免误伤 ccache、ccleaner 这类英文词）。
  if (lower.startsWith(config.trigger)) {
    const rest = text.slice(config.trigger.length);
    if (rest === '' || !/^[a-z0-9]/i.test(rest)) {
      return rest.replace(/^[\s:：,，、.。!！?？~～\-—_]+/, '').trim();
    }
  }
  // 2) @机器人 提及
  if (botUsername && lower.includes(`@${botUsername.toLowerCase()}`)) {
    return text.replace(new RegExp(`@${botUsername}`, 'ig'), '').trim();
  }
  // 3) 回复机器人自己的消息
  if (msg.reply_to_message?.from?.username === botUsername) return text;
  // 4) 私聊（非群组）里直接说话
  if (ctx.chat.type === 'private') return text;

  return null;
}

// Telegram 单条消息上限 4096，按行切成多段发送
async function reply(ctx, text) {
  const LIMIT = 3800;
  const chunks = [];
  let buf = '';
  for (const line of text.split('\n')) {
    if (buf.length + line.length + 1 > LIMIT) {
      if (buf) chunks.push(buf);
      // 单行过长则硬切
      if (line.length > LIMIT) {
        for (let i = 0; i < line.length; i += LIMIT) chunks.push(line.slice(i, i + LIMIT));
        buf = '';
      } else {
        buf = line;
      }
    } else {
      buf = buf ? `${buf}\n${line}` : line;
    }
  }
  if (buf) chunks.push(buf);
  for (const c of chunks) await ctx.reply(c);
}

// 只放行白名单用户，未授权静默忽略
function authed(ctx) {
  return config.allowedUserIds.has(ctx.from.id);
}

// /ccwhoami：不需要白名单，帮 Nicola 拿到自己的 user_id 和群的 chat_id
bot.command('ccwhoami', (ctx) => {
  ctx.reply(
    `你的 user_id: ${ctx.from.id}\n当前 chat_id: ${ctx.chat.id}\nchat 类型: ${ctx.chat.type}\n\n把 user_id 填进 .env 的 ALLOWED_USER_IDS 即可授权。`,
  );
});

// /cchelp、/start：帮助
const HELP = [
  '我是 cc 🤖。命令都以 cc 开头：',
  '· 直接对我说话：「cc: 你的需求」（或 @我 / 回复我）',
  '· /ccnew —— 清空上下文、开新会话',
  '· /cccompact —— 压缩上下文（生成摘要、省 token、保留主线）',
  '· /ccproject <路径> —— 切换工作目录（自动开新会话）',
  '· /ccmodel <opus|sonnet|haiku> —— 切换模型；不带参数查看当前',
  '· /ccwhoami —— 查看你的 ID',
].join('\n');
bot.command(['cchelp', 'start'], (ctx) => ctx.reply(HELP));

// /ccnew：重置当前 chat 的会话
bot.command('ccnew', (ctx) => {
  if (!authed(ctx)) return;
  resetSession(ctx.chat.id);
  ctx.reply('🆕 已开启新会话，之前的上下文已清空。');
});

// /cccompact：压缩上下文——生成摘要后清空长历史，摘要作为新会话背景
bot.command('cccompact', async (ctx) => {
  if (!authed(ctx)) return;
  if (isBusy(ctx.chat.id)) return ctx.reply('⏳ 上一个任务还在跑，请稍候。');
  const note = await ctx.reply('🗜 正在压缩上下文（生成摘要中，可能要十几秒）…').catch(() => null);
  try {
    const res = await compactSession(ctx.chat.id);
    if (note) await ctx.api.deleteMessage(ctx.chat.id, note.message_id).catch(() => {});
    if (!res.ok) return ctx.reply(`ℹ️ ${res.error}`);
    await reply(ctx, `✅ 已压缩上下文：旧的长历史已清空，下面这份摘要会作为新会话的背景。\n\n📋 摘要：\n${res.summary}`);
  } catch (e) {
    if (note) await ctx.api.deleteMessage(ctx.chat.id, note.message_id).catch(() => {});
    await ctx.reply(`❌ 压缩失败：${e.message}`);
  }
});

// /ccproject <路径>：切换工作目录并开新会话；不带参数则显示当前目录
bot.command('ccproject', (ctx) => {
  if (!authed(ctx)) return;
  const arg = ctx.match?.trim();
  if (!arg) {
    return ctx.reply(`📁 当前工作目录：${getWorkDir(ctx.chat.id)}\n\n切换：/ccproject ~/IdeaProjects/项目名`);
  }
  const res = setWorkDir(ctx.chat.id, arg);
  if (!res.ok) return ctx.reply(`❌ 切换失败：${res.error}\n你给的路径：${arg}`);
  resetSession(ctx.chat.id); // 切项目 = 换上下文，自动清空旧会话
  ctx.reply(`📁 已切到：${res.path}\n🆕 同时开启了新会话。下一条消息起我就在这个项目里干活。`);
});

// /ccmodel <模型>：切换模型；不带参数显示当前。别名 opus/sonnet/haiku 自动指向各档最新模型
bot.command('ccmodel', (ctx) => {
  if (!authed(ctx)) return;
  const arg = ctx.match?.trim();
  if (!arg) {
    return ctx.reply(
      `🧠 当前模型：${getModel(ctx.chat.id)}\n\n` +
        '切换：/ccmodel opus | sonnet | haiku\n' +
        '也可填完整模型 id（新模型发布时）：/ccmodel claude-opus-4-8\n' +
        '提示：opus/sonnet/haiku 别名会自动指向各档最新模型，通常无需手动切。',
    );
  }
  setModel(ctx.chat.id, arg);
  const known = ['opus', 'sonnet', 'haiku'].includes(arg.toLowerCase());
  ctx.reply(
    `🧠 已切换模型为：${arg}\n下一条消息起生效（无需 /ccnew，可继续当前会话）。` +
      (known ? '' : '\n⚠️ 非标准别名，若此模型名无效，下次对话会报错，可再用 /ccmodel opus 改回。'),
  );
});

// 从 claude 回复里提取要发送的本机文件：[[file: 路径]] 或 Markdown 图片 ![](路径)
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
function expandHomePath(p) {
  if (p === '~') return process.env.HOME;
  if (p.startsWith('~/')) return join(process.env.HOME, p.slice(2));
  return p;
}
function extractAttachments(text) {
  const files = [];
  let cleaned = text;
  const patterns = [/!\[[^\]]*\]\(\s*([^)]+?)\s*\)/g, /\[\[file:\s*([^\]]+?)\s*\]\]/g];
  for (const re of patterns) {
    cleaned = cleaned.replace(re, (match, captured) => {
      const path = expandHomePath(captured.trim());
      if (path.startsWith('/') && existsSync(path) && statSync(path).isFile()) {
        files.push(path);
        return '';
      }
      return match; // 不是本地文件（如 http 链接）就原样保留
    });
  }
  return { text: cleaned.replace(/\n{3,}/g, '\n\n').trim(), files };
}
async function sendAttachments(ctx, files) {
  for (const f of files) {
    const ext = (f.match(/\.[^./]+$/)?.[0] || '').toLowerCase();
    try {
      if (IMAGE_EXT.has(ext)) await ctx.replyWithPhoto(new InputFile(f));
      else await ctx.replyWithDocument(new InputFile(f));
    } catch (e) {
      await ctx.reply(`⚠️ 上传文件失败 ${f.split('/').pop()}：${e.message}`);
    }
  }
}

// 进度面板：把 claude 的执行步骤实时编辑进同一条消息（节流 2.5s），方便监督
class ProgressReporter {
  constructor(ctx) {
    this.ctx = ctx;
    this.chatId = ctx.chat.id;
    this.steps = [];
    this.messageId = undefined;
    this.lastRendered = '';
    this.dirty = false;
    this.timer = undefined;
  }

  async start() {
    const initial = '🛠 cc 处理中…';
    const msg = await this.ctx.reply(initial).catch(() => null);
    this.messageId = msg?.message_id;
    this.lastRendered = initial;
    this.timer = setInterval(() => void this.flush(), 2500);
    await this.ctx.replyWithChatAction('typing').catch(() => {});
  }

  push(step) {
    this.steps.push(step);
    this.dirty = true;
  }

  render() {
    const shown = this.steps.slice(-20);
    const omitted = this.steps.length - shown.length;
    const lines = ['🛠 cc 处理中…'];
    if (omitted > 0) lines.push(`…（前 ${omitted} 步略）`);
    shown.forEach((s, i) => lines.push(`${omitted + i + 1}. ${s}`));
    return lines.join('\n').slice(0, 3500);
  }

  async flush() {
    if (!this.dirty || !this.messageId) return;
    const text = this.render();
    this.dirty = false;
    if (text === this.lastRendered) return;
    this.lastRendered = text;
    await this.ctx.api.editMessageText(this.chatId, this.messageId, text).catch(() => {});
  }

  async finish(ok) {
    this.stop();
    if (!this.messageId) return;
    // 纯问答没有工具步骤 → 删掉进度消息保持干净
    if (this.steps.length === 0) {
      await this.ctx.api.deleteMessage(this.chatId, this.messageId).catch(() => {});
      return;
    }
    const tailCount = Math.min(8, this.steps.length);
    const startIndex = this.steps.length - tailCount;
    const tail = this.steps.slice(startIndex).map((s, i) => `${startIndex + i + 1}. ${s}`);
    const head = ok
      ? `✅ cc 完成（共 ${this.steps.length} 步）`
      : `⚠️ cc 结束（共 ${this.steps.length} 步，未完全成功）`;
    await this.ctx.api
      .editMessageText(this.chatId, this.messageId, [head, ...tail].join('\n').slice(0, 3500))
      .catch(() => {});
  }

  async fail() {
    this.stop();
    if (!this.messageId) return;
    await this.ctx.api
      .editMessageText(this.chatId, this.messageId, `❌ cc 处理失败（共 ${this.steps.length} 步）`)
      .catch(() => {});
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

// 跑一次 cc 请求：白名单 + 进度面板 + 调 claude + 回贴（文本和附件消息共用）
async function runCc(ctx, prompt) {
  if (config.allowedUserIds.size === 0) {
    return ctx.reply('⚠️ 尚未配置白名单。请先发送 /ccwhoami 拿到你的 user_id，填入 .env 的 ALLOWED_USER_IDS 后重启我。');
  }
  if (!config.allowedUserIds.has(ctx.from.id)) {
    console.warn(`[bot] 拒绝未授权用户 ${ctx.from.id} (@${ctx.from.username})`);
    return; // 静默忽略
  }
  if (!prompt.trim()) return ctx.reply('你想让我做什么？在「cc:」后面写上内容。');
  if (isBusy(ctx.chat.id)) return ctx.reply('⏳ 上一个任务还在跑，请稍候。');

  const progress = new ProgressReporter(ctx);
  await progress.start();

  try {
    const { text, isError } = await askClaude(ctx.chat.id, prompt, (s) => progress.push(s));
    await progress.finish(!isError);
    const { text: cleaned, files } = extractAttachments(text || '');
    if (cleaned) await reply(ctx, cleaned);
    else if (files.length === 0) await reply(ctx, '(空)');
    await sendAttachments(ctx, files);
    if (isError) console.warn('[bot] claude 返回错误');
  } catch (e) {
    await progress.fail();
    await ctx.reply(`❌ 处理出错：${e.message}`);
  } finally {
    progress.stop();
  }
}

// 把 Telegram 上的文件下载到本机，返回绝对路径（复用代理 agent）
async function downloadTelegramFile(ctx, fileId, suggestedName) {
  const f = await ctx.api.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${config.botToken}/${f.file_path}`;
  const safeName = (suggestedName || f.file_path.split('/').pop()).replace(/[/\\]/g, '_');
  mkdirSync(DOWNLOAD_DIR, { recursive: true });
  const dest = join(DOWNLOAD_DIR, `${Date.now()}_${safeName}`);
  await new Promise((resolve, reject) => {
    https
      .get(url, { agent: proxyAgent }, (res) => {
        if (res.statusCode !== 200) return reject(new Error(`下载 HTTP ${res.statusCode}`));
        const ws = createWriteStream(dest);
        res.pipe(ws);
        ws.on('finish', () => ws.close(() => resolve()));
        ws.on('error', reject);
      })
      .on('error', reject);
  });
  return dest;
}

bot.on('message:text', (ctx) => {
  const prompt = extractPrompt(ctx);
  if (prompt === null) return; // 不是对 cc 说话，忽略
  return runCc(ctx, prompt);
});

// 处理带文档/图片附件的消息：下载到本机，再把本地路径交给 claude
bot.on(['message:document', 'message:photo'], async (ctx) => {
  const prompt = extractPrompt(ctx); // 文字在 caption 里，已兼容
  if (prompt === null) return; // 没叫 cc / 不是回复我 → 不处理
  if (!config.allowedUserIds.has(ctx.from.id)) {
    if (config.allowedUserIds.size === 0)
      return ctx.reply('⚠️ 尚未配置白名单，请先 /ccwhoami 配置后重启我。');
    console.warn(`[bot] 拒绝未授权用户 ${ctx.from.id} 的附件`);
    return; // 不给陌生人下载文件
  }
  if (isBusy(ctx.chat.id)) return ctx.reply('⏳ 上一个任务还在跑，请稍候。');

  const msg = ctx.message;
  let fileId, fileName, mime;
  if (msg.document) {
    ({ file_id: fileId, file_name: fileName, mime_type: mime } = msg.document);
  } else {
    fileId = msg.photo[msg.photo.length - 1].file_id; // 取最大尺寸
    fileName = 'photo.jpg';
    mime = 'image/jpeg';
  }

  const note = await ctx.reply('📎 收到附件，正在下载…').catch(() => null);
  let localPath;
  try {
    localPath = await downloadTelegramFile(ctx, fileId, fileName);
  } catch (e) {
    return ctx.reply(`❌ 下载附件失败：${e.message}`);
  } finally {
    if (note) await ctx.api.deleteMessage(ctx.chat.id, note.message_id).catch(() => {});
  }

  const hint = [
    prompt || '请读取并处理这个附件。',
    '',
    `[用户发来一个附件，已下载到本机绝对路径：${localPath}`,
    ` 文件名：${fileName || '(无)'}，类型：${mime || '(未知)'}]`,
    '若是 .docx/.doc/.xlsx/.pptx 等非纯文本，可用 macOS 自带 `textutil -convert txt -stdout <文件>` 等工具转换后读取。',
  ].join('\n');

  return runCc(ctx, hint);
});

bot.catch((err) => console.error('[bot] 未捕获错误:', err));
