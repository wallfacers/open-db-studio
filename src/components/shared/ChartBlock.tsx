import React, { useState, useCallback, useMemo, memo, useRef, useEffect, useLayoutEffect } from 'react';
import ReactDOM from 'react-dom';
import ReactECharts from 'echarts-for-react';
// 重要：必须从 'echarts/core' 导入，与测试中 vi.mock('echarts/core') 路径一致
// 不要改成 import * as echarts from 'echarts'（全包路径）
import * as echarts from 'echarts/core';
import { Copy, Check, AlertTriangle, Maximize2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

// ── ODS 暗色主题（与项目色系一致）────────────────────────────────────────────
const COLOR_PALETTE = [
  '#00c9a7', // 品牌青绿（主系列）
  '#4a9eca', // 天蓝
  '#7b8ff0', // 蓝紫
  '#e07b54', // 暖橙
  '#f0c94a', // 琥珀黄
  '#a78bfa', // 柔紫
  '#34d399', // 翠绿
  '#f87171', // 玫红
];

const ODS_CHART_THEME = {
  color: COLOR_PALETTE,
  backgroundColor: '#0d1117',
  textStyle: {
    color: '#c8daea',
    fontFamily: 'ui-monospace, "Cascadia Code", Consolas, monospace',
    fontSize: 12,
  },
  title: {
    textStyle: { color: '#c8daea', fontSize: 13, fontWeight: 'normal' },
    subtextStyle: { color: '#7a9bb8', fontSize: 11 },
  },
  legend: {
    textStyle: { color: '#7a9bb8' },
    inactiveColor: '#2a3f5a',
    pageTextStyle: { color: '#7a9bb8' },
  },
  tooltip: {
    backgroundColor: '#151d28',
    borderColor: '#2a3f5a',
    borderWidth: 1,
    textStyle: { color: '#c8daea', fontSize: 12 },
    extraCssText: 'box-shadow: 0 4px 12px rgba(0,0,0,0.5);',
  },
  axisPointer: {
    lineStyle: { color: '#2a3f5a' },
    crossStyle: { color: '#2a3f5a' },
    label: { backgroundColor: '#151d28', borderColor: '#2a3f5a', color: '#c8daea' },
  },
  categoryAxis: {
    axisLine:  { lineStyle: { color: '#1e2d42' } },
    axisTick:  { lineStyle: { color: '#1e2d42' } },
    axisLabel: { color: '#7a9bb8', fontSize: 11 },
    splitLine: { lineStyle: { color: '#1e2d42', type: 'dashed' } },
    splitArea: { areaStyle: { color: ['rgba(30,45,66,0.15)', 'rgba(30,45,66,0.05)'] } },
  },
  valueAxis: {
    axisLine:  { lineStyle: { color: '#1e2d42' } },
    axisTick:  { lineStyle: { color: '#1e2d42' } },
    axisLabel: { color: '#7a9bb8', fontSize: 11 },
    splitLine: { lineStyle: { color: '#1e2d42', type: 'dashed' } },
    splitArea: { areaStyle: { color: ['rgba(30,45,66,0.15)', 'rgba(30,45,66,0.05)'] } },
  },
  logAxis: {
    axisLine:  { lineStyle: { color: '#1e2d42' } },
    axisTick:  { lineStyle: { color: '#1e2d42' } },
    axisLabel: { color: '#7a9bb8', fontSize: 11 },
    splitLine: { lineStyle: { color: '#1e2d42', type: 'dashed' } },
  },
  timeAxis: {
    axisLine:  { lineStyle: { color: '#1e2d42' } },
    axisTick:  { lineStyle: { color: '#1e2d42' } },
    axisLabel: { color: '#7a9bb8', fontSize: 11 },
    splitLine: { lineStyle: { color: '#1e2d42', type: 'dashed' } },
  },
  line: {
    symbol: 'circle',
    symbolSize: 5,
    smooth: false,
    lineStyle: { width: 2 },
    emphasis: { lineStyle: { width: 3 } },
  },
  bar: {
    barMaxWidth: 48,
    itemStyle: { borderRadius: [2, 2, 0, 0] },
    emphasis: { itemStyle: { opacity: 0.85 } },
  },
  pie: {
    radius: ['0%', '65%'],
    label: { color: '#c8daea', fontSize: 11 },
    labelLine: { lineStyle: { color: '#2a3f5a' } },
    emphasis: { label: { color: '#e8f4fd', fontWeight: 'bold' } },
  },
  scatter: {
    symbolSize: 8,
    emphasis: { symbolSize: 12 },
  },
  candlestick: {
    itemStyle: {
      color: '#00c9a7',
      color0: '#f87171',
      borderColor: '#00c9a7',
      borderColor0: '#f87171',
    },
  },
  radar: {
    name: { textStyle: { color: '#7a9bb8' } },
    axisLine: { lineStyle: { color: '#1e2d42' } },
    splitLine: { lineStyle: { color: '#1e2d42', type: 'dashed' } },
    splitArea: { areaStyle: { color: ['rgba(30,45,66,0.2)', 'rgba(30,45,66,0.05)'] } },
  },
  dataZoom: {
    backgroundColor: '#111922',
    dataBackground: {
      lineStyle: { color: '#2a3f5a' },
      areaStyle: { color: 'rgba(42,63,90,0.3)' },
    },
    fillerColor: 'rgba(0,201,167,0.12)',
    handleStyle: { color: '#00c9a7', borderColor: '#009e84' },
    textStyle: { color: '#7a9bb8' },
  },
  visualMap: {
    color: ['#00c9a7', '#4a9eca', '#151d28'],
    textStyle: { color: '#7a9bb8' },
  },
  toolbox: {
    iconStyle: { borderColor: '#2a3f5a' },
    emphasis: { iconStyle: { borderColor: '#00c9a7' } },
  },
  timeline: {
    lineStyle: { color: '#2a3f5a' },
    itemStyle: { color: '#00c9a7' },
    label: { color: '#7a9bb8' },
    controlStyle: { color: '#7a9bb8', borderColor: '#2a3f5a' },
  },
};

// 模块加载时注册一次，之后所有 ReactECharts theme="ods-dark" 均使用此主题
echarts.registerTheme('ods-dark', ODS_CHART_THEME);

// ── 图表放大弹框 ──────────────────────────────────────────────────────────────
const ChartExpandModal: React.FC<{
  option: Record<string, unknown>;
  chartType: string;
  onClose: () => void;
}> = memo(({ option, chartType, onClose }) => {
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  return ReactDOM.createPortal(
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center bg-black/70"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-[#111922] border border-[#253347] rounded-lg shadow-2xl w-[90vw] max-w-5xl max-h-[90vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2.5 bg-[#161b22] border-b border-[#1e2d42] flex-shrink-0">
          <span className="text-xs text-[#7a9bb8] font-mono">{chartType}</span>
          <button
            onClick={onClose}
            className="text-[#7a9bb8] hover:text-[#c8daea] transition-colors"
            title="关闭"
          >
            <X size={16} />
          </button>
        </div>
        <div className="flex-1 min-h-0 p-2">
          <ReactECharts
            option={option}
            theme="ods-dark"
            style={{ height: '70vh', width: '100%' }}
            notMerge={true}
            opts={{ renderer: 'canvas' }}
          />
        </div>
      </div>
    </div>,
    document.body
  );
});

// ── ErrorBoundary（捕获 ECharts 渲染异常，降级为文字提示）────────────────────
interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback: React.ReactNode;
}
class ChartErrorBoundary extends React.Component<ErrorBoundaryProps, { hasError: boolean }> {
  state = { hasError: false };
  static getDerivedStateFromError() { return { hasError: true }; }
  render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}

// ── 根据图表数据估算合适高度 ─────────────────────────────────────────────────
const CHART_MIN_HEIGHT = 240;
const CHART_MAX_HEIGHT = 480;
const CHART_DEFAULT_HEIGHT = 320;

function calcChartHeight(option: Record<string, unknown>): number {
  const series = (option.series as Array<{ type?: string }> | undefined) ?? [];
  const chartType = series[0]?.type ?? '';
  const yAxis = option.yAxis as { data?: unknown[] } | undefined;

  // 水平条形图：Y 轴为分类，行数多则需要更高的容器
  if (chartType === 'bar' && yAxis && Array.isArray(yAxis.data)) {
    const rows = yAxis.data.length;
    return Math.min(Math.max(rows * 28 + 100, CHART_MIN_HEIGHT), CHART_MAX_HEIGHT);
  }

  return CHART_DEFAULT_HEIGHT;
}

// ── 修复 grid / 轴标签，避免与绘图区或标题重叠 ──────────────────────────────
// 1. grid.containLabel: true  — 将轴刻度标签纳入 grid 计算，自动留出空间
// 2. yAxis.nameLocation/nameRotate — Y 轴 name 默认顶端会压住标题/图例，改为居中旋转
function injectOptionFix(option: Record<string, unknown>): Record<string, unknown> {
  // ── fix grid ──
  let result: Record<string, unknown>;
  if (!option.grid) {
    result = { ...option, grid: { containLabel: true } };
  } else if (Array.isArray(option.grid)) {
    result = {
      ...option,
      grid: (option.grid as object[]).map((g) => ({ containLabel: true, ...g })),
    };
  } else {
    result = { ...option, grid: { containLabel: true, ...(option.grid as object) } };
  }

  // ── fix yAxis name：保持顶端显示，但确保 grid.top 足够大避免与标题/图例重叠 ──
  // yAxis.name 默认 nameLocation='end'（轴顶端），ECharts 将其渲染在 grid 顶边附近。
  // title + legend 位于 grid 上方，若 grid.top 太小则三者重叠。
  // 方案：检测到 yAxis 有 name 时，将 grid.top 撑到至少 80px，给标题+图例留出空间。
  const hasYAxisName = (() => {
    if (!result.yAxis) return false;
    if (Array.isArray(result.yAxis)) return (result.yAxis as Record<string, unknown>[]).some((a) => !!a.name);
    return !!(result.yAxis as Record<string, unknown>).name;
  })();

  if (hasYAxisName) {
    const MIN_TOP = 80;
    const currentGrid = result.grid as Record<string, unknown>;
    const currentTop = typeof currentGrid?.top === 'number' ? currentGrid.top : 0;
    if (currentTop < MIN_TOP) {
      result = { ...result, grid: { ...currentGrid, top: MIN_TOP } };
    }

    // nameTextStyle.align:'right' 使文字从 Y 轴顶端锚点向左延伸，整体视觉偏左
    const shiftYAxisNameLeft = (axis: Record<string, unknown>) => {
      if (!axis.name) return axis;
      const existing = (axis.nameTextStyle ?? {}) as Record<string, unknown>;
      return { ...axis, nameTextStyle: { align: 'right', ...existing } };
    };
    if (Array.isArray(result.yAxis)) {
      result = { ...result, yAxis: (result.yAxis as Record<string, unknown>[]).map(shiftYAxisNameLeft) };
    } else {
      result = { ...result, yAxis: shiftYAxisNameLeft(result.yAxis as Record<string, unknown>) };
    }
  }

  // ── fix title backgroundColor：AI 可能带自定义背景色，统一透明避免色块异常 ──
  if (result.title) {
    const normalizeTitle = (t: Record<string, unknown>) => ({ ...t, backgroundColor: 'transparent' });
    if (Array.isArray(result.title)) {
      result = { ...result, title: (result.title as Record<string, unknown>[]).map(normalizeTitle) };
    } else {
      result = { ...result, title: normalizeTitle(result.title as Record<string, unknown>) };
    }
  }

  return result;
}

// ── ChartRenderer：独立组件
// 初始以 '100%' 宽度渲染 ECharts，避免 jsdom / SSR 等无布局环境下 canvas 不渲染。
// useLayoutEffect 同步读取真实像素宽度后更新，ResizeObserver 处理后续面板拉伸。
const ChartRenderer: React.FC<{ option: Record<string, unknown> }> = ({ option }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | string>('100%');

  const height = calcChartHeight(option);
  const fixedOption = injectOptionFix(option);

  // useLayoutEffect：DOM commit 后、paint 前同步读宽度，有效时替换 '100%'
  useLayoutEffect(() => {
    const w = containerRef.current?.clientWidth ?? 0;
    if (w > 0) setWidth(w);
  }, []);

  // ResizeObserver：处理后续容器宽度变化（面板拉伸、布局变化等）
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w > 0) setWidth(w);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={containerRef} style={{ height }}>
      <ReactECharts
        option={fixedOption}
        theme="ods-dark"
        style={{ height, width }}
        notMerge={true}
        opts={{ renderer: 'canvas' }}
      />
    </div>
  );
};

// ── ChartBlock ────────────────────────────────────────────────────────────────
// 重要约定：此组件只负责渲染，不持有外部 state；所有状态均在组件内部管理。
export const ChartBlock: React.FC<{ code: string; isStreaming?: boolean }> = memo(({ code, isStreaming = false }) => {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { option, error } = useMemo(() => {
    try {
      return { option: JSON.parse(code) as Record<string, unknown>, error: null };
    } catch (e) {
      return { option: null, error: (e as Error).message };
    }
  }, [code]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard 不可用时静默失败
    }
  }, [code]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  // ── 流式中 JSON 不完整：显示加载动画 ──
  if (error && isStreaming) {
    // 柱高序列：低→中→高→中→低，营造波形感
    const barHeights = [20, 32, 44, 32, 20];
    return (
      <div data-testid="chart-streaming" className="my-2 rounded overflow-hidden border border-[#1e2d42]">
        <div className="flex items-center gap-2 px-3 py-1.5 bg-[#161b22] border-b border-[#1e2d42]">
          <span className="ai-dot w-1.5 h-1.5 rounded-full bg-[#00c9a7] flex-shrink-0" />
          <span className="text-xs text-[#5b8ab0] animate-pulse">{t('commonComponents.chartBlock.generatingChart')}</span>
        </div>
        <div className="bg-[#0d1117] flex items-center justify-center" style={{ height: CHART_DEFAULT_HEIGHT }}>
          <div className="flex flex-col items-center gap-3">
            <div className="flex gap-2 items-end">
              {barHeights.map((h, i) => (
                <div
                  key={i}
                  className="w-3 rounded-t bg-[#00c9a7]/70 chart-bar-anim"
                  style={{ height: h, animationDelay: `-${(i * 0.22).toFixed(2)}s` }}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── 错误状态（非流式，JSON 确实有误）──
  if (error) {
    return (
      <div data-testid="chart-error" className="my-2 rounded overflow-hidden border border-red-800/40">
        <div className="flex items-center gap-2 px-3 py-2 bg-red-900/20 border-b border-red-800/40">
          <AlertTriangle size={13} className="text-red-400 flex-shrink-0" />
          <span className="text-xs text-red-400">{t('commonComponents.chartBlock.chartDataError')}</span>
        </div>
        <pre className="bg-[#0d1117] text-[#f87171] text-xs p-3 overflow-x-auto font-mono whitespace-pre-wrap">
          {code}
        </pre>
      </div>
    );
  }

  // 从 series[0].type 推断图表类型标签（option 在此处必然非 null）
  const chartType = (
    (option!.series as Array<{ type?: string }>)?.[0]?.type ?? 'chart'
  );

  // 背景色始终强制覆盖（放在 spread 后，防止 AI 输出把它覆盖掉）
  const mergedOption = { ...option!, backgroundColor: '#0d1117' };

  // ── 正常渲染 ──
  return (
    <div data-testid="chart-block" className="my-2 rounded overflow-hidden border border-[#1e2d42]">
      {/* 工具栏（与 CodeBlock 风格一致） */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-[#161b22] border-b border-[#1e2d42]">
        <span className="text-xs text-[#7a9bb8] font-mono">{chartType}</span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 text-xs text-[#7a9bb8] hover:text-[#c8daea] transition-colors"
        >
          {copied ? (
            <><Check size={12} className="text-[#00c9a7]" /><span className="text-[#00c9a7]">{t('commonComponents.chartBlock.copied')}</span></>
          ) : (
            <><Copy size={12} /><span>{t('commonComponents.chartBlock.copy')}</span></>
          )}
        </button>
      </div>

      {/* ECharts 渲染区，ErrorBoundary 捕获渲染异常 */}
      <ChartErrorBoundary
        key={code}
        fallback={
          <div className="bg-[#0d1117] text-[#7a9bb8] text-xs p-4 text-center">
            {t('commonComponents.chartBlock.renderFailed')}
          </div>
        }
      >
        <ChartRenderer option={mergedOption} />
      </ChartErrorBoundary>
    </div>
  );
});

ChartBlock.displayName = 'ChartBlock';
