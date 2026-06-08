// 封装对本机 claude CLI 的 headless 调用
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SESSIONS_FILE = join(__dirname, '..', 'data', 'sessions.json');

// launchd 启动时 PATH 极简，找不到 claude/node/brew 工具。
// 用启动本服务的 node 所在目录（claude 也在那）+ Homebrew 目录补全 PATH。
const NODE_BIN_DIR = dirname(process.execPath);
const childEnv = {
  ...process.env,
  PATH: `${NODE_BIN_DIR}:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}`,
};
// claude 调 Anthropic API 必须走代理，否则中国 IP 会被地域限制返回 403。
// launchd 进程环境里没有代理变量，这里用已配的 PROXY_URL 显式注入。
if (config.proxyUrl) {
  childEnv.HTTPS_PROXY = config.proxyUrl;
  childEnv.HTTP_PROXY = config.proxyUrl;
  childEnv.https_proxy = config.proxyUrl;
  childEnv.http_proxy = config.proxyUrl;
}
const WORKDIRS_FILE = join(__dirname, '..', 'data', 'workdirs.json');
const MODELS_FILE = join(__dirname, '..', 'data', 'models.json');

// 简单的 JSON 持久化小工具
function loadJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}
function saveJson(file, obj) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.error(`[claude] 保存 ${file} 失败:`, e.message);
  }
}

// chatId -> session_id：保持 TG 群里对话连续性
const sessions = loadJson(SESSIONS_FILE);
// chatId -> 工作目录：每个群可单独切换项目
const workdirs = loadJson(WORKDIRS_FILE);
// chatId -> 模型：每个群可单独切换模型（别名或完整 id）
const models = loadJson(MODELS_FILE);

export function resetSession(chatId) {
  delete sessions[String(chatId)];
  saveJson(SESSIONS_FILE, sessions);
}

export function getWorkDir(chatId) {
  return workdirs[String(chatId)] || config.workDir;
}

export function getModel(chatId) {
  return models[String(chatId)] || config.model;
}

export function setModel(chatId, model) {
  models[String(chatId)] = model.trim();
  saveJson(MODELS_FILE, models);
}

// 把开头的 ~ 展开为家目录
function expandHome(p) {
  if (p === '~') return process.env.HOME;
  if (p.startsWith('~/')) return join(process.env.HOME, p.slice(2));
  return p;
}

// 设置某个 chat 的工作目录，返回 { ok, path } 或 { ok:false, error }
export function setWorkDir(chatId, rawPath) {
  const path = expandHome(rawPath.trim());
  try {
    if (!statSync(path).isDirectory()) return { ok: false, error: '这不是一个目录' };
  } catch {
    return { ok: false, error: '目录不存在' };
  }
  workdirs[String(chatId)] = path;
  saveJson(WORKDIRS_FILE, workdirs);
  return { ok: true, path };
}

// 同一会话同一时刻只允许一个 claude 进程，避免 resume 竞争
const busy = new Set();
export function isBusy(chatId) {
  return busy.has(String(chatId));
}

// 告诉 claude 如何把本机文件发到群里（桥接层会拦截标记并上传）
const FILE_INSTRUCTION =
  '如果需要把本机文件（图片、二维码、截图、文档等）发送到当前 Telegram 对话，' +
  '请在回复中单独写一行：[[file: 文件的绝对路径]]，系统会自动把该文件作为附件上传；' +
  '也可以用 Markdown 图片语法 ![说明](绝对路径)。不要只贴本地路径让用户自己去找。';

// 把 claude 的一次 tool_use 渲染成一行进度（给群里看）
function shorten(value, n) {
  const s = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
function basename(p) {
  return String(p ?? '').split('/').pop();
}
function renderTool(block) {
  const input = block.input || {};
  switch (block.name) {
    case 'Bash':
      return `🔧 ${shorten(input.command || input.description || 'bash', 120)}`;
    case 'Read':
      return `📖 读取 ${basename(input.file_path)}`;
    case 'Write':
      return `📝 写入 ${basename(input.file_path)}`;
    case 'Edit':
    case 'MultiEdit':
      return `📝 编辑 ${basename(input.file_path)}`;
    case 'NotebookEdit':
      return `📝 编辑 ${basename(input.notebook_path)}`;
    case 'Grep':
      return `🔍 搜索 ${shorten(input.pattern, 60)}`;
    case 'Glob':
      return `🔍 查找 ${shorten(input.pattern, 60)}`;
    case 'Task':
      return `🤖 子任务 ${shorten(input.description, 60)}`;
    case 'WebFetch':
      return `🌐 ${shorten(input.url, 80)}`;
    case 'WebSearch':
      return `🌐 搜索 ${shorten(input.query, 60)}`;
    case 'TodoWrite':
      return '📋 更新待办';
    default:
      return `🔧 ${block.name}`;
  }
}

/**
 * 以 headless 方式调用 claude（stream-json 流式）。
 * onProgress(step) 在每次工具调用时回调一次，用于推送进度。
 * 返回 { text, sessionId, isError }
 */
export function askClaude(chatId, prompt, onProgress) {
  const key = String(chatId);
  return new Promise((resolve) => {
    if (busy.has(key)) {
      resolve({ text: '⏳ 上一个任务还在跑，请等它结束再发。', isError: true });
      return;
    }
    busy.add(key);

    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      config.permissionMode,
      '--model',
      getModel(chatId),
      '--append-system-prompt',
      FILE_INSTRUCTION,
    ];
    const prev = sessions[key];
    if (prev) args.push('--resume', prev);

    const child = spawn('claude', args, {
      cwd: getWorkDir(chatId),
      env: childEnv,
    });

    let stderr = '';
    let buffer = '';
    let resultText = '';
    let sessionId;
    let isError = false;
    let sawResult = false;

    const handleEvent = (evt) => {
      if (evt.type === 'system' && evt.subtype === 'init') {
        if (evt.session_id) sessionId = evt.session_id;
      } else if (evt.type === 'assistant' && Array.isArray(evt.message?.content)) {
        for (const block of evt.message.content) {
          if (block.type === 'tool_use' && onProgress) onProgress(renderTool(block));
        }
      } else if (evt.type === 'result') {
        sawResult = true;
        if (evt.session_id) sessionId = evt.session_id;
        if (typeof evt.result === 'string') resultText = evt.result;
        isError = !!evt.is_error;
      }
    };
    const handleLine = (line) => {
      const t = line.trim();
      if (!t.startsWith('{')) return;
      try {
        handleEvent(JSON.parse(t));
      } catch {
        // 跳过非 JSON 行
      }
    };

    child.stdout.on('data', (d) => {
      buffer += d.toString();
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        handleLine(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
      }
    });
    child.stderr.on('data', (d) => (stderr += d));

    child.on('error', (err) => {
      busy.delete(key);
      resolve({ text: `❌ 启动 claude 失败：${err.message}`, isError: true });
    });

    child.on('close', (code) => {
      busy.delete(key);
      if (buffer.trim()) handleLine(buffer);
      if (sessionId) {
        sessions[key] = sessionId;
        saveJson(SESSIONS_FILE, sessions);
      }
      if (!sawResult && code !== 0) {
        // resume 失败（如 session 过期）等：清掉旧 session 让下次重来
        if (prev) resetSession(chatId);
        resolve({
          text: `❌ claude 退出码 ${code}\n${stderr.slice(0, 1500)}`,
          isError: true,
        });
        return;
      }
      resolve({ text: resultText || '(claude 返回了空内容)', sessionId, isError });
    });

    // 通过 stdin 传 prompt，避免命令行参数转义问题
    child.stdin.write(prompt);
    child.stdin.end();
  });
}
