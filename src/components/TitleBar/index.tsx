import React, { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Minus, Square, X, Maximize2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Tooltip } from '../common/Tooltip';
import appIcon from '../../assets/icon.png';
import { useAiStore } from '../../store/aiStore';

export const TitleBar: React.FC = () => {
  const { t } = useTranslation();
  const [isMaximized, setIsMaximized] = useState(false);
  const isAiChatting = useAiStore(
    (s) => Object.values(s.chatStates).some((cs) => cs.isChatting)
  );
  const appWindow = getCurrentWindow();

  useEffect(() => {
    appWindow.isMaximized().then(setIsMaximized);
    const unlisten = appWindow.onResized(() => {
      appWindow.isMaximized().then(setIsMaximized);
    });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  return (
    <div
      className="flex items-center justify-between h-8 bg-background-base border-b border-border-subtle flex-shrink-0 select-none"
      data-tauri-drag-region
    >
      <div className="flex items-center px-3 gap-2" data-tauri-drag-region>
        <img src={appIcon} alt="Open DB Studio" className="w-4 h-4 rounded-sm" />
        {isAiChatting ? (
          <>
            <span className="flex items-center gap-[3px]">
              {[0, 0.2, 0.4].map((delay) => (
                <span
                  key={delay}
                  className="ai-dot w-1 h-1 rounded-full bg-accent flex-shrink-0"
                  style={{ animationDelay: `${delay}s` }}
                />
              ))}
            </span>
            <span className="text-accent text-[11px]">AI 正在响应</span>
          </>
        ) : (
          <span className="text-foreground-subtle text-[11px]">Open DB Studio</span>
        )}
      </div>

      <div className="flex items-center h-full">
        <Tooltip content={t('titleBar.minimize')}>
          <button
            className="w-8 h-8 flex items-center justify-center text-foreground-subtle hover:text-foreground-default hover:bg-background-hover transition-colors"
            onClick={() => appWindow.minimize()}
          >
            <Minus size={12} />
          </button>
        </Tooltip>
        <Tooltip content={isMaximized ? t('titleBar.restore') : t('titleBar.maximize')}>
          <button
            className="w-8 h-8 flex items-center justify-center text-foreground-subtle hover:text-foreground-default hover:bg-background-hover transition-colors"
            onClick={() => appWindow.toggleMaximize()}
          >
            {isMaximized ? <Square size={11} /> : <Maximize2 size={11} />}
          </button>
        </Tooltip>
        <Tooltip content={t('titleBar.close')}>
          <button
            className="w-8 h-8 flex items-center justify-center text-foreground-subtle hover:text-foreground hover:bg-window-close-hover transition-colors"
            onClick={() => appWindow.close()}
          >
            <X size={13} />
          </button>
        </Tooltip>
      </div>
    </div>
  );
};
