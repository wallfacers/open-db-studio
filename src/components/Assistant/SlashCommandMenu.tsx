import React, { useEffect, useRef, useMemo } from 'react';
import { CornerDownLeft, CornerUpRight, Zap, Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { SlashCommand, ChatCommandState, CommandContext } from './slashCommands';

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
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);

  // 动态生成命令列表，包含国际化文本
  const commands = useMemo<SlashCommand[]>(() => [
    {
      name: 'undo',
      label: '/undo',
      description: t('assistant.slashCommands.undo.description'),
      icon: CornerDownLeft,
      isAvailable: (s) => s.canUndo && !s.isChatting && !s.isCompacting,
      disabledReason: (s) => {
        if (s.isChatting) return t('assistant.slashCommands.undo.disabledChatting');
        if (s.isCompacting) return t('assistant.slashCommands.undo.disabledCompacting');
        return t('assistant.slashCommands.undo.disabledNoHistory');
      },
      execute: async (ctx) => {
        await ctx.undoMessage(ctx.sessionId);
        ctx.showToast(t('assistant.slashCommands.undo.done'), 'info');
      },
    },
    {
      name: 'redo',
      label: '/redo',
      description: t('assistant.slashCommands.redo.description'),
      icon: CornerUpRight,
      isAvailable: (s) => s.canRedo,
      disabledReason: () => t('assistant.slashCommands.redo.disabledNoHistory'),
      execute: async (ctx) => {
        await ctx.redoMessage(ctx.sessionId);
        ctx.showToast(t('assistant.slashCommands.redo.done'), 'info');
      },
    },
    {
      name: 'compact',
      label: '/compact',
      description: t('assistant.slashCommands.compact.description'),
      icon: Zap,
      isAvailable: (s) => s.messageCount >= 4 && !s.isChatting && !s.isCompacting,
      disabledReason: (s) => {
        if (s.isChatting) return t('assistant.slashCommands.compact.disabledChatting');
        if (s.isCompacting) return t('assistant.slashCommands.compact.disabledCompacting');
        return t('assistant.slashCommands.compact.disabledNotEnough');
      },
      execute: async (ctx) => {
        if (!ctx.modelId || !ctx.providerId) {
          ctx.showToast(t('assistant.slashCommands.compact.disabledNoModel'), 'warning');
          return;
        }
        await ctx.compactSession(ctx.sessionId, ctx.modelId, ctx.providerId);
        ctx.showToast(t('assistant.slashCommands.compact.done'), 'info');
      },
    },
    {
      name: 'new',
      label: '/new',
      description: t('assistant.slashCommands.new.description'),
      icon: Plus,
      isAvailable: () => true,
      execute: async (ctx) => {
        await ctx.newSession();
        ctx.showToast(t('assistant.slashCommands.new.done'), 'info');
      },
    },
    {
      name: 'clear',
      label: '/clear',
      description: t('assistant.slashCommands.clear.description'),
      icon: Trash2,
      isAvailable: (s) => s.hasHistory,
      disabledReason: () => t('assistant.slashCommands.clear.disabledNoHistory'),
      execute: async (ctx) => {
        await ctx.clearHistory(ctx.sessionId);
        ctx.showToast(t('assistant.slashCommands.clear.done'), 'info');
      },
    },
  ], [t]);

  // 过滤命令
  const filtered = useMemo(() => {
    if (!query) return commands;
    const q = query.toLowerCase();
    return commands.filter((c) => c.name.startsWith(q));
  }, [query, commands]);

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
      commandContext.showToast(t('assistant.slashCommands.executeFailed', { cmd: cmd.label, error: String(e) }), 'error');
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
