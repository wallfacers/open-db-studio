export const ROW_NUM_WIDTH = 40;

const CELL_PADDING = 24;   // px-3 两侧各 12px
const HEADER_EXTRA = 20;   // 排序按钮宽度 + gap
const COL_MIN = 60;
const COL_MAX = 400;

const TABLE_FONT = '12px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

let _canvas: HTMLCanvasElement | null = null;

function measureText(text: string): number {
  if (typeof document === 'undefined') return text.length * 7;
  if (!_canvas) _canvas = document.createElement('canvas');
  const ctx = _canvas.getContext('2d');
  if (!ctx) return text.length * 7;
  ctx.font = TABLE_FONT;
  return ctx.measureText(text).width;
}

/**
 * 计算每列的基础宽度：
 * 取列名实际渲染宽度（含排序按钮区域）与前 sampleSize 行单元格最大宽度中的较大值。
 */
export function computeColumnWidths(
  columns: string[],
  rows: (string | number | boolean | null)[][] = [],
  sampleSize = 100,
): number[] {
  const sample = rows.slice(0, sampleSize);
  return columns.map((col, ci) => {
    const headerW = measureText(col) + CELL_PADDING + HEADER_EXTRA;
    let maxCellW = 0;
    for (const row of sample) {
      const cell = row[ci];
      if (cell !== null && cell !== undefined) {
        const w = measureText(String(cell)) + CELL_PADDING;
        if (w > maxCellW) maxCellW = w;
      }
    }
    return Math.min(COL_MAX, Math.max(COL_MIN, Math.ceil(Math.max(headerW, maxCellW))));
  });
}

/**
 * 若所有列的总宽度小于容器可用宽度，则按比例放大各列以撑满容器；
 * 否则原样返回（容器出现水平滚动条）。
 */
export function adjustColumnWidths(
  baseWidths: number[],
  containerWidth: number,
  rowNumWidth: number = ROW_NUM_WIDTH,
): number[] {
  if (baseWidths.length === 0 || containerWidth <= 0) return baseWidths;
  const totalBase = baseWidths.reduce((a, b) => a + b, 0);
  const available = containerWidth - rowNumWidth;
  if (totalBase >= available) return baseWidths;
  const scale = available / totalBase;
  return baseWidths.map(w => Math.floor(w * scale));
}
