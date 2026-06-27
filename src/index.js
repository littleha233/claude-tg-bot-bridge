import { bot } from './bot.js';
import { config } from './config.js';

// 全局兜底：代理(FlyingBird 7892)偶发 TLS 抖动会在底层 socket 抛出"未监听的 'error' 事件"，
// grammy 的 bot.catch 兜不住这种进程级异常，不拦就会直接崩掉整个进程(靠 launchd 30s 后重启，
// 期间漏消息、在途回复丢失)。这里把"瞬时网络/TLS 错误"降级为日志，保持长轮询存活；
// grammy 会自动继续拉取更新。只有非网络类异常才视作真 bug、醒目记录(同样保持进程不退)。
const TRANSIENT =
  /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|ENOTFOUND|EAI_AGAIN|ERR_SSL|bad record mac|decryption failed|socket disconnected|tls|ssl|network socket/i;

function isTransient(err) {
  const msg = (err && (err.message || err.code)) || String(err);
  return TRANSIENT.test(msg) || TRANSIENT.test((err && err.code) || '');
}

process.on('uncaughtException', (err) => {
  if (isTransient(err)) {
    console.warn('[guard] 忽略瞬时网络/TLS 错误，进程继续:', err.message || err);
    return;
  }
  console.error('[guard] ⚠️ 未捕获异常(非网络类，请排查，但进程保持存活):', err);
});

process.on('unhandledRejection', (reason) => {
  console.warn('[guard] 未处理的 Promise rejection:', reason?.message || reason);
});

console.log('[start] nicola-agent-bridge 启动中…');
console.log(`[start] 工作目录: ${config.workDir}`);
console.log(`[start] 模型: ${config.model} | 权限模式: ${config.permissionMode}`);
console.log(
  `[start] 白名单: ${config.allowedUserIds.size ? [...config.allowedUserIds].join(', ') : '(空，仅 /whoami 可用)'}`,
);

bot.start({
  onStart: () => console.log('[start] ✅ 已开始监听 Telegram 消息'),
});

process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());
