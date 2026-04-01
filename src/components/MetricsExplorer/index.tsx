import React from 'react';
import { useTranslation } from 'react-i18next';
import { Activity } from 'lucide-react';
import { MetricsTree } from './MetricsTree';

export function MetricsExplorer() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col h-full bg-[var(--background-panel)]">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border-default)]">
        <Activity size={14} className="text-[var(--accent)]" />
        <span className="text-xs font-semibold text-[var(--foreground-muted)] uppercase tracking-wider">
          {t('metricsExplorer.title')}
        </span>
      </div>
      <MetricsTree />
    </div>
  );
}
