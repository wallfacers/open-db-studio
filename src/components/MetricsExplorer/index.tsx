import React from 'react';
import { useTranslation } from 'react-i18next';
import { Activity } from 'lucide-react';
import { MetricsTree } from './MetricsTree';

export function MetricsExplorer() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col h-full bg-[#111922]">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[#1e2d42]">
        <Activity size={14} className="text-[#00c9a7]" />
        <span className="text-xs font-semibold text-[#a0b4c8] uppercase tracking-wider">
          {t('metricsExplorer.title')}
        </span>
      </div>
      <MetricsTree />
    </div>
  );
}
