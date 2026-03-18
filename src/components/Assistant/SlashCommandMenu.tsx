import React, { useEffect, useRef } from 'react';
import { CornerDownLeft, CornerUpRight, Zap, Plus, Trash2 } from 'lucide-react';
import type { SlashCommand, ChatCommandState, CommandContext } from './slashCommands';

// ── 命令注册表 ────────────────────────────────────────────────────────────────

const COMMANDS: SlashCommand[] = [
  {
    name: 'undo',
    label: '/undo',
    description: '撤销最后一轮对话',
    icon: CornerDownLeft,
    isAvailable: (s) => s.canUndo && !s.isChatting && !s.isCompacting,
    disabledReason: (s) => {
      if (s.isChatting) return '正在回复中，请等待完成';
      if (s.isCompacting) return '正在压缩中，请等待完成';
      return '暂无可撤销的对话';
    },
    execute: async (ctx) => {
      await ctx.undoMessage(ctx.sessionId);
      ctx.showToast('已撤销最后一轮对话', 'info');
    },
  },
  {
    name: 'redo',
    label: '/redo',
    description: '恢复被撤销的对话',
    icon: CornerUpRight,
    isAvailable: (s) => s.canRedo,
    disabledReason: () => '暂无可恢复的对话',
    execute: async (ctx) => {
      await ctx.redoMessage(ctx.sessionId);
      ctx.showToast('已恢复对话', 'info');
    },
  },
  {
    name: 'compact',
    label: '/compact',
    description: '压缩会话 context',
    icon: Zap,
    isAvailable: (s) => s.messageCount >= 4 && !s.isChatting && !s.isCompacting,
    disabledReason: (s) => {
      if (s.isChatting) return '正在回复中，请等待完成';
      if (s.isCompacting) return '正在压缩中，请等待完成';
      return '消息不足 4 条，无需压缩';
    },
    execute: async (ctx) => {
      if (!ctx.modelId || !ctx.providerId) {
        ctx.showToast('未配置模型，无法压缩', 'warning');
        return;
      }
      await ctx.compactSession(ctx.sessionId, ctx.modelId, ctx.providerId);
      ctx.showToast('会话已压缩', 'info');
    },
  },
  {
    name: 'new',
    label: '/new',
    description: '新建会话',
    icon: Plus,
    isAvailable: () => true,
    execute: async (ctx) => {
      await ctx.newSession();
      ctx.showToast('新会话已创建', 'info');
    },
  },
  {
    name: 'clear',
    label: '/clear',
    description: '清空当前会话',
    icon: Trash2,
    isAvailable: (s) => s.hasHistory,
    disabledReason: () => '当前会话无历史消息',
    execute: async (ctx) => {
      await ctx.clearHistory(ctx.sessionId);
      ctx.showToast('会话已清空', 'info');
    },
  },
];

// ── 过滤辅助 ──────────────────────────────────────────────────────────────────

function filterCommands(query: string): SlashCommand[] {
  if (!query) return COMMANDS;
  const q = query.toLowerCase();
  return COMMANDS.filter((c) => c.name.startsWith(q));
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface SlashCommandMenuProps {
  query: string;
  activeIndex: number;
  commandState: ChatCommandState;
  commandContext: CommandContext;
  onClose: () => void;
  onIndexChange: (index: number) => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export const SlashCommandMenu: React.FC<SlashCommandMenuProps> = ({
  query,
  activeIndex,
  commandState,
  commandContext,
  onClose,
  onIndexChange,
}) => {
  const filtered = filterCommands(query);
  const menuRef = useRef<HTMLDivElement>(null);

  // 点击区域外关闭
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [onClose]);

  // 键盘导航
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        onIndexChange(Math.min(activeIndex + 1, filtered.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        onIndexChange(Math.max(activeIndex - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const cmd = filtered[activeIndex];
        if (cmd) executeCommand(cmd);
      } else if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [activeIndex, filtered, onClose, onIndexChange]); // eslint-disable-line react-hooks/exhaustive-deps

  const executeCommand = async (cmd: SlashCommand) => {
    const available = cmd.isAvailable(commandState);
    if (!available) return;
    onClose();
    try {
      await cmd.execute(commandContext);
    } catch (e) {
      commandContext.showToast(`${cmd.label} 执行失败: ${String(e)}`, 'error');
    }
  };

  if (filtered.length === 0) {
    onClose();
    return null;
  }

  return (
    <div
      ref={menuRef}
      className="absolute bottom-full left-0 w-full z-50 mb-1 bg-[#111922] border border-[#2a3f5a] rounded-lg shadow-lg overflow-hidden"
    >
      {filtered.map((cmd, idx) => {
        const available = cmd.isAvailable(commandState);
        const isActive = idx === activeIndex;
        const Icon = cmd.icon;
        const reason = !available && cmd.disabledReason ? cmd.disabledReason(commandState) : undefined;

        return (
          <div
            key={cmd.name}
            className={`flex items-center gap-2 px-3 py-2 cursor-pointer transition-colors ${
              isActive ? 'bg-[#1e2d42]' : 'hover:bg-[#151d28]'
            } ${!available ? 'opacity-40 cursor-not-allowed' : ''}`}
            onMouseEnter={() => onIndexChange(idx)}
            onClick={() => executeCommand(cmd)}
            title={reason}
          >
            <Icon size={14} className="flex-shrink-0 text-[#00c9a7]" />
            <span className="text-[13px] font-medium text-[#c8daea] w-20 flex-shrink-0">{cmd.label}</span>
            <span className="text-[12px] text-[#7a9bb8] truncate">{cmd.description}</span>
            {!available && reason && (
              <span className="ml-auto text-[11px] text-[#5b8ab0] flex-shrink-0 hidden group-hover:block">
                {reason}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
};
