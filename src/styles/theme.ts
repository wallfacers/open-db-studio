/**
 * 项目统一 UI 样式常量
 * 禁止在组件中硬编码重复的颜色/间距字符串，统一从此处引用。
 */

// ──────────────── 调色板 ────────────────
export const colors = {
  // 背景层级
  bgPrimary:   '#080d12',   // 最深背景（编辑器区）
  bgSecondary: '#0d1117',   // 次级背景（表头、footer）
  bgPanel:     '#111922',   // 面板/弹框背景
  bgHover:     '#1a2639',   // 通用悬停背景
  bgSelected:  '#1e2d42',   // 选中背景
  bgInput:     '#1a2639',   // 输入框背景

  // 边框
  borderMuted:  '#1e2d42',  // 淡边框（表格行）
  borderDefault:'#253347',  // 标准边框（输入框、卡片）
  borderLight:  '#2a3f5a',  // 浅边框（下拉框、菜单）

  // 文字
  textPrimary:   '#c8daea', // 主要文字
  textSecondary: '#b5cfe8', // 次要文字（树节点）
  textMuted:     '#7a9bb8', // 辅助文字（placeholder、图标）
  textSelected:  '#e8f4ff', // 选中状态文字
  textDisabled:  '#4a6480', // 禁用文字
  textDanger:    '#f87171', // 危险操作文字（红）

  // 强调色
  accent:      '#00c9a7',   // 主强调（绿）
  accentDark:  '#009e84',   // 深绿（选中状态）
  accentHover: '#00a98f',   // 悬停绿
} as const;

// ──────────────── 通用类名片段 ────────────────
export const cls = {
  // 树形节点行
  treeRow: [
    'flex items-center py-1 px-2',
    'cursor-pointer select-none outline-none',
    `hover:bg-[${colors.bgHover}]`,
  ].join(' '),
  treeRowSelected: `bg-[${colors.bgSelected}]`,

  // 展开图标容器
  treeChevron: 'w-4 h-4 mr-1 flex items-center justify-center flex-shrink-0',

  // 节点图标
  treeIcon:         `mr-1.5 flex-shrink-0 text-[${colors.textMuted}]`,
  treeIconActive:   `mr-1.5 flex-shrink-0 text-[${colors.accent}]`,

  // 节点文字
  treeLabel:         `text-[13px] truncate text-[${colors.textSecondary}]`,
  treeLabelSelected: `text-[13px] truncate text-[${colors.textSelected}]`,

  // 右键/下拉菜单容器
  menuContainer: [
    'fixed z-50 py-1 min-w-[160px]',
    `bg-[${colors.bgSecondary}] border border-[${colors.borderLight}]`,
    'rounded shadow-xl',
  ].join(' '),

  // 菜单项
  menuItem: [
    'w-full text-left px-3 py-1.5 text-xs',
    'flex items-center gap-2',
    `text-[${colors.textPrimary}] hover:bg-[${colors.bgHover}] hover:text-white`,
  ].join(' '),
  menuItemDanger: [
    'w-full text-left px-3 py-1.5 text-xs',
    'flex items-center gap-2',
    `text-[${colors.textDanger}] hover:bg-[${colors.bgHover}] hover:text-red-300`,
  ].join(' '),
  menuItemDisabled: [
    'w-full text-left px-3 py-1.5 text-xs',
    'flex items-center gap-2',
    `text-[${colors.textMuted}] opacity-40 cursor-not-allowed`,
  ].join(' '),
  menuDivider: `h-px bg-[${colors.borderLight}] my-1`,

  // 表格行
  tableRow:         `hover:bg-[${colors.bgHover}] border-b border-[${colors.borderMuted}]`,
  tableRowSelected: `bg-[${colors.bgSelected}]`,
  tableCell:        `px-3 py-1.5 border-r border-[${colors.borderMuted}] text-[${colors.textPrimary}]`,
  tableHeader:      `sticky top-0 bg-[${colors.bgSecondary}] z-10`,

  // 输入框
  input: [
    `bg-[${colors.bgInput}] border border-[${colors.borderDefault}]`,
    'rounded px-3 py-1.5 text-sm text-white outline-none',
    `focus:border-[${colors.accent}] transition-colors`,
  ].join(' '),

  // 弹框遮罩
  modalOverlay: 'fixed inset-0 z-50 flex items-center justify-center bg-black/60',

  // 弹框容器
  modalPanel: [
    `bg-[${colors.bgPanel}] border border-[${colors.borderDefault}]`,
    'rounded-lg shadow-2xl',
  ].join(' '),

  // 关闭按钮
  closeButton: `text-[${colors.textMuted}] hover:text-[${colors.textPrimary}] transition-colors`,
} as const;
