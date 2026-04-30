// preprocessStreamingContent.js

export function preprocessStreamingContent(text) {
  if (!text) return text;
  if (!text.includes('|')) return text;

  const lines = text.split('\n');
  const result = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trimStart().startsWith('|')) {
      result.push(line);
      i++;
      continue;
    }

    // 收集连续的 | 开头行
    const tableLines = [];
    let j = i;
    while (j < lines.length && lines[j].trimStart().startsWith('|')) {
      tableLines.push(lines[j]);
      j++;
    }

    if (isTableComplete(tableLines)) {
      for (const tl of tableLines) result.push(tl);
    } else {
      const cols = estimateCols(tableLines);
      const dataRows = estimateDataRows(tableLines);
      result.push(buildSkeletonHtml(cols, dataRows));
    }

    i = j;
  }

  return result.join('\n');
}

/**
 * 分隔行判断
 * 修复点：原正则 /^\s*\|[\s\-:|]+\|\s*$/ 只匹配单列，多列 |---|---| 匹配失败
 * 正确做法：把行按 | 拆开，逐个 cell 检查是否全为 -/:/ 空格
 */
function isSeparatorLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.includes('-')) return false;

  // 去掉首尾的 |，再按 | 分割
  const inner = trimmed.replace(/^\||\|$/g, '');
  const cells = inner.split('|');

  if (cells.length === 0) return false;

  // 每个 cell 必须只含 -、:、空格，且至少含一个 -
  return cells.every(cell => /^[\s:\-]+$/.test(cell) && cell.includes('-'));
}

/**
 * 表格完整性判断
 * 修复点：原来 separatorIdx >= tableLines.length - 1 的判断
 * 会在「标题 + 分隔 + 1行数据」= 3行时，separatorIdx=1，length-1=2，
 * 1 < 2 所以是 false（不触发），逻辑是对的——但依赖 isSeparatorLine 正确识别
 * 修复 isSeparatorLine 后这里逻辑无需改动
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

  if (separatorIdx <= 0) return false;              // 没找到，或分隔行在首行（无标题）
  if (separatorIdx >= tableLines.length - 1) return false; // 分隔行后没有数据行

  return true;
}

/**
 * 从标题行估算列数
 * 修复点：原来直接 split('|').filter(s => s.trim() !== '')
 * 对 `| A | B |` 这种首尾有 | 的标准格式是对的
 * 但对 `A | B`（无首尾 |）会少算，加一个归一化处理
 */
function estimateCols(tableLines) {
  const headerLine = (tableLines[0] || '').trim();
  // 去掉首尾 | 后再 split，避免空字符串干扰
  const inner = headerLine.replace(/^\||\|$/g, '');
  const count = inner.split('|').filter(s => s.trim() !== '').length;
  return Math.max(count, 2);
}

function estimateDataRows(tableLines) {
  let separatorIdx = -1;
  for (let i = 0; i < tableLines.length; i++) {
    if (isSeparatorLine(tableLines[i])) {
      separatorIdx = i;
      break;
    }
  }
  const known = separatorIdx >= 0 ? tableLines.length - separatorIdx - 1 : 0;
  return Math.max(known, 3);
}

function buildSkeletonHtml(cols, rows) {
  const WIDTHS = ['72%', '88%', '55%', '92%', '66%'];
  const w = (r, c) => WIDTHS[(r * cols + c) % WIDTHS.length];

  const thCells = Array.from({ length: cols }, (_, c) =>
    `<th style="padding:8px 12px;border:1px solid #e0e0e0;background:#f7f7f7;">` +
    `<div style="height:12px;border-radius:3px;width:${w(0, c)};${shimmer(c * 0.08)}"></div>` +
    `</th>`
  ).join('');

  const trRows = Array.from({ length: rows }, (_, r) => {
    const tds = Array.from({ length: cols }, (_, c) =>
      `<td style="padding:8px 12px;border:1px solid #e0e0e0;">` +
      `<div style="height:12px;border-radius:3px;width:${w(r + 1, c)};${shimmer((r * cols + c) * 0.07)}"></div>` +
      `</td>`
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

function shimmer(delay) {
  return [
    'background:linear-gradient(90deg,#e8e8e8 25%,#f2f2f2 50%,#e8e8e8 75%)',
    'background-size:200% 100%',
    `animation:_tbl-shimmer 1.4s ease-in-out ${delay.toFixed(2)}s infinite`,
  ].join(';');
}

export function injectShimmerStyle() {
  const ID = '__tbl_shimmer_style__';
  if (document.getElementById(ID)) return;
  const style = document.createElement('style');
  style.id = ID;
  style.textContent =
    '@keyframes _tbl-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}';
  document.head.appendChild(style);
}