// 从环境变量读取配置（通过 `node --env-file=.env` 注入）
function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`[config] 缺少必需的环境变量 ${name}，请检查 .env`);
    process.exit(1);
  }
  return v;
}

export const config = {
  botToken: required('BOT_TOKEN'),
  // 白名单：逗号分隔的数字 ID，转成 Set<number>
  allowedUserIds: new Set(
    (process.env.ALLOWED_USER_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number),
  ),
  workDir: process.env.WORK_DIR || process.env.HOME,
  model: process.env.MODEL || 'opus',
  permissionMode: process.env.PERMISSION_MODE || 'bypassPermissions',
  trigger: (process.env.TRIGGER || 'cc').toLowerCase(),
  // 访问 Telegram 用的代理，如 http://127.0.0.1:7890 或 socks5://127.0.0.1:7891；留空则直连
  proxyUrl: process.env.PROXY_URL || '',
};
