import { bot } from './bot.js';
import { config } from './config.js';

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
