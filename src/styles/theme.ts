/**
 * 项目统一 UI 样式常量
 * 禁止在组件中硬编码重复的颜色/间距字符串，统一从此处引用。
 * 完整色彩规范见 docs/design-system/color-system-proposal.md
 */

// ──────────────── 调色板 ────────────────
export const colors = {
  // 背景层级
  bgPrimary:   'var(--background-void)',     // 最深背景（编辑器区）
  bgSecondary: 'var(--background-base)',     // 次级背景（表头、footer）
  bgPanel:     'var(--background-panel)',    // 面板/弹框背景
  bgElevated:  'var(--background-elevated)', // 浮层/卡片
  bgHover:     'var(--background-hover)',    // 通用悬停背景
  bgActive:    'var(--background-active)',   // 选中/激活背景
  bgSelected:  'var(--background-active)',   // 选中背景
  bgInput:     'var(--background-hover)',    // 输入框背景
  bgDeep:      'var(--background-deep)',     // 极深背景（工具栏/breadcrumb）
  bgCode:      'var(--background-code)',     // 代码块/Markdown 头部背景

  // 边框
  borderSubtle: 'var(--border-subtle)',   // 极细分隔线
  borderMuted:  'var(--border-default)',  // 淡边框（表格行）
  borderDefault:'var(--border-strong)',   // 标准边框（输入框、卡片）
  borderLight:  'var(--border-strong)',   // 浅边框（下拉框、菜单）
  borderFocus:  'var(--border-focus)',    // 焦点边框

  // 文字
  textBright:    'var(--foreground)',         // 最亮文字（标题、hover）
  textPrimary:   'var(--foreground-default)', // 主要文字（正文）
  textSecondary: 'var(--foreground)',         // 次要文字（树节点）
  textMuted:     'var(--foreground-muted)',   // 辅助文字（描述、时间戳）
  textSubtle:    'var(--foreground-subtle)',  // 占位符
  textSelected:  'var(--foreground)',         // 选中状态文字
  textDisabled:  'var(--foreground-ghost)',   // 禁用文字
  textDanger:    'var(--error)',              // 危险操作文字

  // 强调色
  accent:       'var(--accent)',        // 主强调（绿）
  accentHover:  'var(--accent-hover)',  // 悬停绿
  accentSubtle: 'var(--accent-subtle)', // 淡绿背景

  // 主色
  primary:       'var(--primary)',        // 主要按钮/链接
  primaryHover:  'var(--primary-hover)',  // 主色 hover
  primarySubtle: 'var(--primary-subtle)', // 主色淡背景

  // 语义状态色
  success:       'var(--success)',
  successSubtle: 'var(--success-subtle)',
  warning:       'var(--warning)',
  warningSubtle: 'var(--warning-subtle)',
  error:         'var(--error)',
  errorSubtle:   'var(--error-subtle)',
  info:          'var(--info)',
  infoSubtle:    'var(--info-subtle)',

  // Diff 色
  diffAdd:      'var(--diff-add)',
  diffAddBg:    'var(--diff-add-bg)',
  diffRemove:   'var(--diff-remove)',
  diffRemoveBg: 'var(--diff-remove-bg)',
  diffModify:   'var(--diff-modify)',
  diffModifyBg: 'var(--diff-modify-bg)',

  // 数据库对象指示
  keyPrimary: 'var(--key-primary)',  // 主键图标
  keyForeign: 'var(--key-foreign)',  // 外键图标

  // 图节点
  nodeTable:    'var(--node-table)',
  nodeTableBg:  'var(--node-table-bg)',
  nodeMetric:   'var(--node-metric)',
  nodeMetricBg: 'var(--node-metric-bg)',
  nodeAlias:    'var(--node-alias)',
  nodeAliasBg:  'var(--node-alias-bg)',

  // 窗口控件
  windowCloseHover: 'var(--window-close-hover)',
  dangerHoverBg:    'var(--danger-hover-bg)',
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
