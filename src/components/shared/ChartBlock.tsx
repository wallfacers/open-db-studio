import React, { useState, useCallback, useMemo, memo } from 'react';
import ReactECharts from 'echarts-for-react';
// 重要：必须从 'echarts/core' 导入，与测试中 vi.mock('echarts/core') 路径一致
// 不要改成 import * as echarts from 'echarts'（全包路径）
import * as echarts from 'echarts/core';
import { Copy, Check, AlertTriangle } from 'lucide-react';

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

// ── ChartBlock ────────────────────────────────────────────────────────────────
// 重要约定：此组件只负责渲染，不持有外部 state；所有状态均在组件内部管理。
export const ChartBlock: React.FC<{ code: string; isStreaming?: boolean }> = memo(({ code, isStreaming = false }) => {
  const [copied, setCopied] = useState(false);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

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

  React.useEffect(() => {
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
          <span className="text-xs text-[#5b8ab0] animate-pulse">AI 正在生成图表数据</span>
        </div>
        <div className="bg-[#0d1117] flex items-center justify-center" style={{ height: 280 }}>
          <div className="flex flex-col items-center gap-3">
            <div className="flex gap-2 items-end">
              {barHeights.map((h, i) => (
                <div
                  key={i}
                  className="w-3 rounded-t bg-[#00c9a7]/70 chart-bar-anim"
                  style={{ height: h }}
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
          <span className="text-xs text-red-400">图表数据格式有误</span>
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

  // 背景色始终强制覆盖，其余字段尊重 AI 输出
  const mergedOption = { backgroundColor: '#0d1117', ...option! };

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
            <><Check size={12} className="text-[#00c9a7]" /><span className="text-[#00c9a7]">已复制</span></>
          ) : (
            <><Copy size={12} /><span>复制</span></>
          )}
        </button>
      </div>

      {/* ECharts 渲染区，ErrorBoundary 捕获渲染异常 */}
      <ChartErrorBoundary
        key={code}
        fallback={
          <div className="bg-[#0d1117] text-[#7a9bb8] text-xs p-4 text-center">
            图表渲染失败
          </div>
        }
      >
        <ReactECharts
          option={mergedOption}
          theme="ods-dark"
          style={{ height: 280 }}
          notMerge={true}
          opts={{ renderer: 'canvas' }}
        />
      </ChartErrorBoundary>
    </div>
  );
});

ChartBlock.displayName = 'ChartBlock';
