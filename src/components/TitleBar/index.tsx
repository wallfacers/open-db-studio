import React, { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Minus, Square, X, Maximize2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Tooltip } from '../common/Tooltip';

export const TitleBar: React.FC = () => {
  const { t } = useTranslation();
  const [isMaximized, setIsMaximized] = useState(false);
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
      className="flex items-center justify-between h-8 bg-[#0d1117] border-b border-[#161e2e] flex-shrink-0 select-none"
      data-tauri-drag-region
    >
      <div className="flex items-center px-3 gap-2" data-tauri-drag-region>
        <div className="w-4 h-4 rounded-sm bg-[#00c9a7] flex items-center justify-center">
          <span className="text-[8px] font-bold text-[#080d12]">DB</span>
        </div>
        <span className="text-[#4a6480] text-[11px]">Open DB Studio</span>
      </div>

      <div className="flex items-center h-full">
        <Tooltip content={t('titleBar.minimize')}>
          <button
            className="w-10 h-full flex items-center justify-center text-[#4a6480] hover:text-[#c8daea] hover:bg-[#1a2639] transition-colors"
            onClick={() => appWindow.minimize()}
          >
            <Minus size={12} />
          </button>
        </Tooltip>
        <Tooltip content={isMaximized ? t('titleBar.restore') : t('titleBar.maximize')}>
          <button
            className="w-10 h-full flex items-center justify-center text-[#4a6480] hover:text-[#c8daea] hover:bg-[#1a2639] transition-colors"
            onClick={() => appWindow.toggleMaximize()}
          >
            {isMaximized ? <Square size={11} /> : <Maximize2 size={11} />}
          </button>
        </Tooltip>
        <Tooltip content={t('titleBar.close')}>
          <button
            className="w-10 h-full flex items-center justify-center text-[#4a6480] hover:text-white hover:bg-[#c0392b] transition-colors"
            onClick={() => appWindow.close()}
          >
            <X size={13} />
          </button>
        </Tooltip>
      </div>
    </div>
  );
};
