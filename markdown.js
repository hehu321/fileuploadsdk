// preprocessStreamingContent.js

/**
 * 流式 Markdown 预处理：将不完整的表格替换为骨架屏 HTML
 * 
 * 设计原则：
 * - 只处理「确认进入了表格但表格还没结束」的块
 * - 完整表格不干预，直接透传给 ReactMarkdown
 * - 用 HTML 骨架替换后，ReactMarkdown 的 rehype 管道会原样输出 HTML（需开启 rehypeRaw）
 */
export function preprocessStreamingContent(text) {
  if (!text) return text;

  // 快速跳过：没有表格特征
  if (!text.includes('|')) return text;

  const lines = text.split('\n');
  const result = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 检测表格起始行（以 | 开头，去除首尾空白）
    if (!line.trimStart().startsWith('|')) {
      result.push(line);
      i++;
      continue;
    }

    // 收集连续的表格行
    const tableLines = [];
    let j = i;
    while (j < lines.length && lines[j].trimStart().startsWith('|')) {
      tableLines.push(lines[j]);
      j++;
    }

    // 判断表格是否完整
    if (isTableComplete(tableLines)) {
      // 完整表格：原样保留，ReactMarkdown 正常渲染
      for (const tl of tableLines) result.push(tl);
    } else {
      // 不完整表格：整块替换为骨架 HTML
      const cols = estimateCols(tableLines);
      const dataRows = estimateDataRows(tableLines);
      result.push(buildSkeletonHtml(cols, dataRows));
    }

    i = j;
  }

  return result.join('\n');
}

/**
 * 表格完整性判断
 * 完整 = 有标题行 + 有分隔行 + 分隔行之后至少一行数据
 */
function isTableComplete(tableLines) {
  if (tableLines.length < 3) return false;

  let separatorIdx = -1;
  for (let i = 0; i < tableLines.length; i++) {
    if (isSeparatorLine(tableLines[i])) {
      separatorIdx = i;
      break;
    }
  }

  if (separatorIdx === -1) return false;           // 没有分隔行
  if (separatorIdx === 0) return false;            // 分隔行在第一行，没有标题
  if (separatorIdx >= tableLines.length - 1) return false; // 分隔行之后没有数据行

  return true;
}

function isSeparatorLine(line) {
  // 匹配 |---|---| 或 |:---:|---| 等格式
  return /^\s*\|[\s\-:|]+\|\s*$/.test(line) && line.includes('-');
}

/** 从标题行估算列数 */
function estimateCols(tableLines) {
  const headerLine = tableLines[0] || '';
  const count = headerLine.split('|').filter(s => s.trim() !== '').length;
  return Math.max(count, 2);
}

/** 估算骨架需要展示的数据行数：已知数据行数，最少 3 行 */
function estimateDataRows(tableLines) {
  let separatorIdx = -1;
  for (let i = 0; i < tableLines.length; i++) {
    if (isSeparatorLine(tableLines[i])) {
      separatorIdx = i;
      break;
    }
  }
  const known = separatorIdx >= 0
    ? tableLines.length - separatorIdx - 1
    : 0;
  return Math.max(known, 3);
}

/** 生成骨架屏 HTML 字符串 */
function buildSkeletonHtml(cols, rows) {
  const WIDTHS = ['72%', '88%', '55%', '92%', '66%'];
  const w = (r, c) => WIDTHS[(r * cols + c) % WIDTHS.length];

  const thCells = Array.from({ length: cols }, (_, c) =>
    `<th style="padding:8px 12px;border:1px solid #e0e0e0;background:#f7f7f7;">
      <div style="height:12px;border-radius:3px;width:${w(0, c)};${shimmer(c * 0.08)}"></div>
    </th>`
  ).join('');

  const trRows = Array.from({ length: rows }, (_, r) => {
    const tds = Array.from({ length: cols }, (_, c) =>
      `<td style="padding:8px 12px;border:1px solid #e0e0e0;">
        <div style="height:12px;border-radius:3px;width:${w(r + 1, c)};${shimmer((r * cols + c) * 0.07)}"></div>
      </td>`
    ).join('');
    return `<tr>${tds}</tr>`;
  }).join('');

  return (
    `<table style="width:100%;border-collapse:collapse;margin:12px 0;table-layout:fixed;">` +
    `<thead><tr>${thCells}</tr></thead>` +
    `<tbody>${trRows}</tbody>` +
    `</table>`
  );
}

/** shimmer 动画内联样式（CSS animation 需要全局注入一次） */
function shimmer(delay) {
  return [
    'background:linear-gradient(90deg,#e8e8e8 25%,#f2f2f2 50%,#e8e8e8 75%)',
    'background-size:200% 100%',
    `animation:_tbl-shimmer 1.4s ease-in-out ${delay.toFixed(2)}s infinite`,
  ].join(';');
}

/**
 * 在组件 mount 时调用一次，注入 shimmer keyframes
 * 放到你的组件 useEffect(() => { injectShimmerStyle() }, []) 里
 */
export function injectShimmerStyle() {
  const ID = '__tbl_shimmer_style__';
  if (document.getElementById(ID)) return;
  const style = document.createElement('style');
  style.id = ID;
  style.textContent =
    '@keyframes _tbl-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}';
  document.head.appendChild(style);
}