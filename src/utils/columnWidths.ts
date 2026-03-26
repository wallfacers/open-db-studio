/** 最小列宽 80px，最大 750px（约 5x 默认 150px） */
const COL_MIN = 80;
const COL_MAX = 750;

/**
 * 根据列名与采样数据估算每列的合适像素宽度。
 * 每字符 ~7px + 32px 左右内边距，结果夹在 [80, 750] 内。
 */
export function computeColumnWidths(
  columns: string[],
  rows: (string | number | boolean | null)[][],
  sampleSize = 50,
): number[] {
  const sample = rows.slice(0, sampleSize);
  return columns.map((col, ci) => {
    let maxLen = col.length;
    for (const row of sample) {
      const cell = row[ci];
      if (cell !== null && cell !== undefined) {
        const len = String(cell).length;
        if (len > maxLen) maxLen = len;
      }
    }
    return Math.min(COL_MAX, Math.max(COL_MIN, Math.round(maxLen * 7 + 32)));
  });
}
