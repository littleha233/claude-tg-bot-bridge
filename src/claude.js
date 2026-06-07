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

export function resetSession(chatId) {
  delete sessions[String(chatId)];
  saveJson(SESSIONS_FILE, sessions);
}

export function getWorkDir(chatId) {
  return workdirs[String(chatId)] || config.workDir;
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

/**
 * 以 headless 方式调用 claude，返回 { text, sessionId, isError }
 */
export function askClaude(chatId, prompt) {
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
      'json',
      '--permission-mode',
      config.permissionMode,
      '--model',
      config.model,
    ];
    const prev = sessions[key];
    if (prev) args.push('--resume', prev);

    const child = spawn('claude', args, {
      cwd: getWorkDir(chatId),
      env: childEnv,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));

    child.on('error', (err) => {
      busy.delete(key);
      resolve({ text: `❌ 启动 claude 失败：${err.message}`, isError: true });
    });

    child.on('close', (code) => {
      busy.delete(key);
      if (code !== 0) {
        // resume 失败（如 session 过期）时，清掉旧 session 让用户重试
        if (prev) resetSession(chatId);
        resolve({
          text: `❌ claude 退出码 ${code}\n${stderr.slice(0, 1500) || stdout.slice(0, 1500)}`,
          isError: true,
        });
        return;
      }
      try {
        const data = JSON.parse(stdout);
        if (data.session_id) {
          sessions[key] = data.session_id;
          saveJson(SESSIONS_FILE, sessions);
        }
        const text = data.result || '(claude 返回了空内容)';
        resolve({ text, sessionId: data.session_id, isError: !!data.is_error });
      } catch (e) {
        resolve({
          text: `❌ 解析 claude 输出失败：${e.message}\n原始输出：${stdout.slice(0, 1000)}`,
          isError: true,
        });
      }
    });

    // 通过 stdin 传 prompt，避免命令行参数转义问题
    child.stdin.write(prompt);
    child.stdin.end();
  });
}
