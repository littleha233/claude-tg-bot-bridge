// Telegram 富文本格式化（cc / cx 两个 bridge 共用同一套逻辑，分别用 .js / .ts 各放一份）。
//
// 背景：模型输出是标准 Markdown（**加粗**、## 标题、表格、```代码块```），而 Telegram
// 默认按纯文本展示，于是群里满屏 ** ## | ``` 符号，又乱又长。这里把 Markdown 转成
// Telegram 支持的 HTML 子集（<b> <i> <code> <pre> <a> <blockquote> <s>），让它们渲染成
// 真正的加粗/标题/代码块，接近正常群聊观感。
//
// 设计要点：
//  - 先把代码块、行内代码"抠出来"占位，避免里面的 < > & 和 * # 被二次处理；
//  - 再整体转义 HTML 特殊字符，然后逐行套用块级（标题/列表/引用/分割线/表格）与行内（粗斜删链）规则；
//  - 转换是"尽力而为"：万一产出非法 HTML 导致 Telegram 解析失败，上层会退回 stripMarkdown 纯文本，
//    保证消息一定发得出去（绝不因格式问题丢回复）。

const Z = String.fromCharCode(0); // 占位符控制字符(NUL)，正常文本不会出现

export function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 行内：在"已转义、已抠掉代码"的文本上套加粗/斜体/删除线/链接
function applyInline(s) {
  let r = s;
  r = r.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>'); // **粗体**
  r = r.replace(/__(.+?)__/g, '<b>$1</b>'); // __粗体__
  // *斜体*：两侧贴非空格、且不与 ** 冲突；保守匹配，避免误伤 a * b
  r = r.replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)(?<!\s)\*(?!\*)/g, '$1<i>$2</i>');
  r = r.replace(/~~(.+?)~~/g, '<s>$1</s>'); // ~~删除线~~
  // [文字](链接)：url 里的 " 编码掉，避免破坏 href 属性
  r = r.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, t, u) => `<a href="${u.replace(/"/g, '%22')}">${t}</a>`);
  return r;
}

// 去掉行内标记、还原为纯文字（表格单元格用，避免 HTML 标签破坏等宽对齐）
function stripInline(s) {
  return s
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)\s]+\)/g, '$1')
    .replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)(?<!\s)\*(?!\*)/g, '$1$2');
}

// 显示宽度：CJK / 全角算 2，其余算 1（让中文表格也能对齐）
function displayWidth(s) {
  let w = 0;
  for (const ch of s) {
    w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch)
      ? 2
      : 1;
  }
  return w;
}
function padTo(s, w) {
  return s + ' '.repeat(Math.max(0, w - displayWidth(s)));
}

function isTableDivider(line) {
  return (
    typeof line === 'string' &&
    line.includes('|') &&
    /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)
  );
}
function isTableRow(line) {
  return typeof line === 'string' && line.includes('|') && line.trim().length > 0;
}
function splitRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => stripInline(c.trim()));
}
function renderTable(rows) {
  const cols = Math.max(...rows.map((r) => r.length));
  const widths = [];
  for (let c = 0; c < cols; c++) {
    widths[c] = Math.max(...rows.map((r) => displayWidth(r[c] || '')));
  }
  const line = (r) => r.map((cell, c) => padTo(cell || '', widths[c])).join('  ').replace(/\s+$/, '');
  const head = line(rows[0]);
  const sep = widths.map((w) => '─'.repeat(w)).join('  ');
  const body = rows.slice(1).map(line);
  // 表格已转义、已 stripInline，安全放进 <pre> 等宽展示
  return `${Z}T${Z}<pre>${[head, sep, ...body].join('\n')}</pre>${Z}T${Z}`;
}

/** 把 Markdown 转成 Telegram HTML 子集字符串 */
export function mdToTelegramHtml(md) {
  if (!md) return '';
  let text = String(md).replace(/\r\n/g, '\n');

  // 1) 抠出围栏代码块 ```lang\n...```
  const blocks = [];
  text = text.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
    const l = (lang || '').trim();
    const inner = escapeHtml(code.replace(/\n+$/, ''));
    const html = l
      ? `<pre><code class="language-${escapeHtml(l)}">${inner}</code></pre>`
      : `<pre>${inner}</pre>`;
    blocks.push(html);
    return `${Z}B${blocks.length - 1}${Z}`;
  });

  // 2) 抠出行内代码 `...`
  const codes = [];
  text = text.replace(/`([^`\n]+)`/g, (_m, code) => {
    codes.push(`<code>${escapeHtml(code)}</code>`);
    return `${Z}C${codes.length - 1}${Z}`;
  });

  // 3) 转义其余 HTML 特殊字符（占位符里没有 < > &，安全）
  text = escapeHtml(text);

  // 4) 逐行处理块级结构
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 表格：当前行像表格行，且下一行是分隔行
    if (isTableRow(line) && isTableDivider(lines[i + 1])) {
      const rows = [splitRow(line)];
      i += 2; // 跳过分隔行
      while (i < lines.length && isTableRow(lines[i]) && !isTableDivider(lines[i])) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      i--; // 抵消 for 的 ++
      out.push(renderTable(rows));
      continue;
    }

    // 分割线 --- *** ___
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      out.push('──────────');
      continue;
    }

    // 标题 # ~ ###### → 整行加粗
    const h = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
    if (h) {
      out.push(`<b>${applyInline(h[2].trim())}</b>`);
      continue;
    }

    // 引用 > （> 已被转义成 &gt;）
    const q = line.match(/^\s{0,3}&gt;\s?(.*)$/);
    if (q) {
      out.push(`<blockquote>${applyInline(q[1])}</blockquote>`);
      continue;
    }

    // 无序列表 - * +
    const ul = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (ul) {
      out.push(`${ul[1]}• ${applyInline(ul[2])}`);
      continue;
    }

    // 有序列表（保留序号）
    const ol = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (ol) {
      out.push(`${ol[1]}${ol[2]}. ${applyInline(ol[3])}`);
      continue;
    }

    out.push(applyInline(line));
  }
  text = out.join('\n');

  // 合并相邻 blockquote，连续引用变成一个整块
  text = text.replace(/<\/blockquote>\n<blockquote>/g, '\n');
  // 表格占位标记去掉
  text = text.replace(new RegExp(`${Z}T${Z}`, 'g'), '');

  // 5) 还原代码占位
  text = text.replace(new RegExp(`${Z}C(\\d+)${Z}`, 'g'), (_m, n) => codes[Number(n)] ?? '');
  text = text.replace(new RegExp(`${Z}B(\\d+)${Z}`, 'g'), (_m, n) => blocks[Number(n)] ?? '');

  return text.replace(/\n{3,}/g, '\n\n').trim();
}

/** 纯文本兜底：去掉 Markdown 标记，HTML 发送失败时退回它，保证一定发得出去 */
export function stripMarkdown(md) {
  if (!md) return '';
  let t = String(md).replace(/\r\n/g, '\n');
  t = t.replace(/```[^\n`]*\n?([\s\S]*?)```/g, (_m, code) => code.replace(/\n+$/, '')); // 代码块保留内容
  t = t.replace(/`([^`\n]+)`/g, '$1');
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, ''); // 标题符号
  t = t.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1');
  t = t.replace(/~~(.+?)~~/g, '$1');
  t = t.replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)(?<!\s)\*(?!\*)/g, '$1$2');
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1（$2）');
  t = t.replace(/^\s*([-*_])\1{2,}\s*$/gm, '──────────');
  t = t.replace(/^(\s*)[-*+]\s+/gm, '$1• ');
  t = t.replace(/^\s{0,3}&gt;\s?/gm, '▏ ').replace(/^\s{0,3}>\s?/gm, '▏ ');
  return t.replace(/\n{3,}/g, '\n\n').trim();
}

/** 按行切分，单条不超过 limit；超长单行硬切。保证 chunk 切在源码行边界上 */
export function chunkByLine(text, limit = 3500) {
  const chunks = [];
  let buf = '';
  for (const line of String(text).split('\n')) {
    if (buf.length + line.length + 1 > limit) {
      if (buf) chunks.push(buf);
      if (line.length > limit) {
        for (let i = 0; i < line.length; i += limit) chunks.push(line.slice(i, i + limit));
        buf = '';
      } else {
        buf = line;
      }
    } else {
      buf = buf ? `${buf}\n${line}` : line;
    }
  }
  if (buf) chunks.push(buf);
  return chunks.length ? chunks : [''];
}
