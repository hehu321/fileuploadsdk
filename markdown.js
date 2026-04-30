// preprocessStreamingContent.js

/**
 * 预处理流式 Markdown 内容：
 * 1. 普通文本原样返回
 * 2. 完整表格原样返回
 * 3. 不完整表格替换为 skeleton HTML，避免直接把半截表格源码渲染出来
 * 4. fenced code block（``` / ~~~）里的内容不处理，避免误伤代码示例
 */
export function preprocessStreamingContent(text) {
  // 空内容直接返回
  if (!text) return text;

  // 没有竖线，说明大概率不含表格，直接返回，减少无意义处理
  if (!text.includes('|')) return text;

  const lines = text.split('\n');
  const result = [];
  let i = 0;

  // 记录当前是否处于 fenced code block 中
  // 例如 ```js ... ``` 或 ~~~ ... ~~~
  let fenceMarker = null;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // 先判断是否是代码块围栏行
    // 命中后直接原样输出，并切换 fence 状态
    if (isFenceDelimiter(trimmed)) {
      const marker = trimmed.slice(0, 3);
      if (!fenceMarker) {
        // 进入代码块
        fenceMarker = marker;
      } else if (fenceMarker === marker) {
        // 退出代码块
        fenceMarker = null;
      }
      result.push(line);
      i++;
      continue;
    }

    // 代码块中的内容一律不做表格预处理
    // 或者当前行根本不像表格起始行，也直接原样输出
    if (fenceMarker || !shouldStartTableBlock(lines, i)) {
      result.push(line);
      i++;
      continue;
    }

    // 从当前行开始，收集连续的“表格块候选行”
    const tableLines = [];
    let j = i;
    while (
      j < lines.length &&
      isTableBlockLine(lines, j) &&
      !isFenceDelimiter(lines[j].trim())
    ) {
      tableLines.push(lines[j]);
      j++;
    }

    // 如果已经是完整表格，则原样输出
    if (isTableComplete(tableLines)) {
      for (const tl of tableLines) result.push(tl);
    } else {
      // 如果是不完整表格，则替换为 skeleton HTML
      const cols = estimateCols(tableLines);
      const dataRows = estimateDataRows(tableLines);
      result.push(buildSkeletonHtml(cols, dataRows));
    }

    // 跳到当前表格块之后继续处理
    i = j;
  }

  return result.join('\n');
}

/**
 * 判断当前行是否为 fenced code block 的开始/结束围栏
 * 支持 ``` 和 ~~~
 */
function isFenceDelimiter(line) {
  return /^(```|~~~)/.test(line);
}

/**
 * 统计一行中竖线 | 的数量
 * 用于辅助判断一行是否“像表格行”
 */
function countPipes(line) {
  return (line.match(/\|/g) || []).length;
}

/**
 * 判断一行是否“像一个独立的表格行”
 *
 * 满足任一条件即认为比较像：
 * 1. 本身是分隔线（---|---）
 * 2. 以 | 开头
 * 3. 以 | 结尾
 * 4. 至少包含 2 个 |（通常意味着至少两列）
 *
 * 这样可以避免把普通句子里的单个 | 误判成表格
 * 例如：
 *   a | b
 * 若只是普通文本，通常不会连续形成完整表格结构
 */
function looksLikeStandaloneTableRow(line) {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return false;
  if (isSeparatorLine(trimmed)) return true;

  return (
    trimmed.startsWith('|') ||
    trimmed.endsWith('|') ||
    countPipes(trimmed) >= 2
  );
}

/**
 * 判断当前行是否和分隔线相邻
 * 用于增强对“无前后竖线表格”的识别，例如：
 *   a | b
 *   ---|---
 *   1 | 2
 */
function isAdjacentToSeparator(lines, index) {
  return (
    isSeparatorLine(lines[index - 1] || '') ||
    isSeparatorLine(lines[index + 1] || '')
  );
}

/**
 * 判断当前位置是否应当作为“表格块”的开始
 *
 * 只有当前行确实有较强表格特征时，才开始进入表格块收集逻辑，
 * 这样可以避免把普通文本中的 | 误替换成 skeleton。
 */
function shouldStartTableBlock(lines, index) {
  const line = lines[index];
  if (!line || !line.includes('|')) return false;

  return looksLikeStandaloneTableRow(line) || isAdjacentToSeparator(lines, index);
}

/**
 * 判断某一行是否属于当前“表格块候选”
 * 和 shouldStartTableBlock 的判定逻辑基本一致
 */
function isTableBlockLine(lines, index) {
  const line = lines[index];
  if (!line || !line.includes('|')) return false;

  return looksLikeStandaloneTableRow(line) || isAdjacentToSeparator(lines, index);
}

/**
 * 判断一行是否为 Markdown 表格分隔线
 * 例如：
 * | --- | --- |
 * | :-- | --: |
 * ---|---
 *
 * 规则：
 * 1. 必须包含 | 和 -
 * 2. 去掉首尾 | 后，按 | 分列
 * 3. 每个单元格只能包含 空格 / : / -
 * 4. 每个单元格至少有一个 -
 */
function isSeparatorLine(line) {
  const trimmed = line.trim();
  if (!trimmed.includes('|') || !trimmed.includes('-')) return false;

  const inner = trimmed.replace(/^\||\|$/g, '');
  const cells = inner.split('|');

  if (cells.length === 0) return false;

  return cells.every(cell => /^[\s:\-]*$/.test(cell) && cell.includes('-'));
}

/**
 * 判断表格块是否已经“完整”
 *
 * 一个完整 Markdown 表格至少应满足：
 * 1. 总行数 >= 3（表头 + 分隔线 + 至少一行数据）
 * 2. 分隔线不能在首行（否则没有表头）
 * 3. 分隔线后必须至少还有一行数据
 *
 * 这里不强求整块每一行都绝对合法，只做“适合流式渲染场景”的轻量判断
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

  // 没找到分隔线，或分隔线在首行 -> 不完整
  if (separatorIdx <= 0) return false;

  // 分隔线后没有数据行 -> 不完整
  if (separatorIdx >= tableLines.length - 1) return false;

  return true;
}

/**
 * 估算 skeleton 应该渲染几列
 *
 * 以候选块第一行作为“表头行”来估算列数：
 * 1. 去掉首尾 |
 * 2. 按 | split
 * 3. 不过滤空字符串，这样可以保留空表头列
 *
 * 例如：
 * | A | | C |
 * 应该算 3 列，而不是 2 列
 */
function estimateCols(tableLines) {
  const headerLine = (tableLines[0] || '').trim();
  const inner = headerLine.replace(/^\||\|$/g, '');
  const count = inner.split('|').length;
  return Math.max(count, 1);
}

/**
 * 估算 skeleton 应该渲染多少行数据
 *
 * 如果已经出现了分隔线，那么：
 *   已知数据行数 = 总行数 - 分隔线位置 - 1
 *
 * 但为了视觉稳定性，最少渲染 3 行 skeleton
 */
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

/**
 * 构建 skeleton table 的 HTML
 *
 * 说明：
 * 1. 表头和单元格都用 div 占位
 * 2. 不同单元格宽度做少量变化，避免完全一致显得太“假”
 * 3. shimmer 动画依赖 injectShimmerStyle 注入的 keyframes
 */
function buildSkeletonHtml(cols, rows) {
  const WIDTHS = ['72%', '88%', '55%', '92%', '66%'];
  const w = (r, c) => WIDTHS[(r * cols + c) % WIDTHS.length];

  // 表头 skeleton
  const thCells = Array.from({ length: cols }, (_, c) =>
    `<th style="padding:8px 12px;border:1px solid #e0e0e0;background:#f7f7f7;">` +
      `<div style="height:12px;border-radius:3px;width:${w(0, c)};${shimmer(c * 0.08)}"></div>` +
    `</th>`
  ).join('');

  // 数据行 skeleton
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

/**
 * 生成 shimmer 动画的内联样式
 * delay 用于让不同单元格的动画错开一点点，更自然
 */
function shimmer(delay) {
  return [
    'background:linear-gradient(90deg,#e8e8e8 25%,#f2f2f2 50%,#e8e8e8 75%)',
    'background-size:200% 100%',
    `animation:_tbl-shimmer 1.4s ease-in-out ${delay.toFixed(2)}s infinite`,
  ].join(';');
}

/**
 * 注入 shimmer 动画样式
 *
 * 注意：
 * 1. 在 SSR / Node 环境中 document 不存在，所以要先保护
 * 2. 用固定 ID 防止重复注入
 */
export function injectShimmerStyle() {
  const ID = '__tbl_shimmer_style__';

  // SSR / Node 环境保护
  if (typeof document === 'undefined') return;

  // 已注入过则不重复注入
  if (document.getElementById(ID)) return;

  const style = document.createElement('style');
  style.id = ID;
  style.textContent =
    '@keyframes _tbl-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}';

  document.head.appendChild(style);
}