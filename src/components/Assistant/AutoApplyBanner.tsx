import React from 'react';
import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface AutoApplyBannerProps {
  reason?: string;
}

export const AutoApplyBanner: React.FC<AutoApplyBannerProps> = ({ reason }) => {
  const { t } = useTranslation();
  return (
    <div className="border-t border-[#1e2d42] bg-[#0d1117]">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <Check size={14} className="text-[#00c9a7] flex-shrink-0" />
        <div className="flex flex-col min-w-0">
          <span className="text-xs font-medium text-[#00c9a7]">{t('assistant.autoApplied')}</span>
          {reason && (
            <span className="text-[11px] text-[#5b8ab0] mt-0.5 break-words">{reason}</span>
          )}
        </div>
      </div>
    </div>
  );
};
