import React, { useState, useEffect } from 'react';
import { Bot, Keyboard, Palette, Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import { LlmSettingsPanel } from './LlmSettings';
import { useAppStore } from '../../store/appStore';

export function SettingsPage() {
  const [activeSection, setActiveSection] = useState('ai');
  const { t } = useTranslation();

  const NAV_ITEMS = [
    { id: 'ai', icon: Bot, label: t('settings.aiModel') },
    { id: 'appearance', icon: Palette, label: t('settings.appearance') },
    { id: 'shortcuts', icon: Keyboard, label: t('settings.shortcuts') },
    { id: 'about', icon: Info, label: t('settings.about') },
  ];

  return (
    <div className="flex-1 flex min-w-0 bg-[#111922]">
      {/* 左侧导航 */}
      <div className="w-48 flex-shrink-0 bg-[#0d1117] border-r border-[#1e2d42] pt-4">
        <div className="px-4 pb-3 text-xs text-[#7a9bb8] font-medium uppercase tracking-wider">{t('settings.title')}</div>
        {NAV_ITEMS.map(({ id, icon: Icon, label }) => (
          <button
            key={id}
            className={`w-full flex items-center px-4 py-2 text-sm text-left transition-colors ${
              activeSection === id
                ? 'bg-[#003d2f] text-white border-l-2 border-[#00c9a7]'
                : 'text-[#7a9bb8] hover:text-[#c8daea] hover:bg-[#1a2639] border-l-2 border-transparent'
            }`}
            onClick={() => setActiveSection(id)}
          >
            <Icon size={15} className="mr-2.5 flex-shrink-0" />
            {label}
          </button>
        ))}
      </div>

      {/* 右侧内容 */}
      <div className="flex-1 overflow-y-auto flex flex-col items-center">
        {activeSection === 'ai' && <AiSection />}
        {activeSection === 'appearance' && <AppearanceSection t={t} />}
        {activeSection === 'shortcuts' && (
          <PlaceholderSection title={t('settings.shortcuts')} description={t('settings.shortcutsDesc')} />
        )}
        {activeSection === 'about' && <AboutSection t={t} />}
      </div>
    </div>
  );
}

function AiSection() {
  const ghostTextDefault = useAppStore((s) => s.ghostTextDefault);
  const setGhostTextDefault = useAppStore((s) => s.setGhostTextDefault);
  const initGhostTextDefault = useAppStore((s) => s.initGhostTextDefault);
  const { t } = useTranslation();

  useEffect(() => {
    initGhostTextDefault();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="w-full flex flex-col items-center">
      <LlmSettingsPanel />
      <div className="w-full max-w-lg px-8 pb-8 space-y-4">
        <h3 className="text-white font-semibold text-sm border-b border-[#1e2d42] pb-2">
          {t('settings.aiInlineCompletion')}
        </h3>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-medium text-[#c8daea] mb-1">{t('settings.ghostText')}</p>
            <p className="text-xs text-[#7a9bb8]">
              {t('settings.ghostTextDesc')}
            </p>
          </div>
          <button
            onClick={() => setGhostTextDefault(!ghostTextDefault)}
            className={`relative w-10 h-5 rounded-full transition-colors flex-shrink-0 ml-4 ${
              ghostTextDefault ? 'bg-[#00c9a7]' : 'bg-[#2a3f5a]'
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                ghostTextDefault ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>
      </div>
    </div>
  );
}

const PAGE_LIMIT_OPTIONS = [100, 500, 1000, 2000, 3000, 5000];

function AppearanceSection({ t }: { t: any }) {
  const [currentLang, setCurrentLang] = useState(i18n.language?.startsWith('zh') ? 'zh' : 'en');
  const tablePageSizeLimit = useAppStore((s) => s.tablePageSizeLimit);
  const setTablePageSizeLimit = useAppStore((s) => s.setTablePageSizeLimit);
  const initTablePageSizeLimit = useAppStore((s) => s.initTablePageSizeLimit);

  useEffect(() => {
    initTablePageSizeLimit();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleLanguageChange = (lang: string) => {
    setCurrentLang(lang);
    i18n.changeLanguage(lang);
  };

  return (
    <div className="w-full max-w-lg p-8 space-y-6">
      <h3 className="text-white font-semibold text-sm border-b border-[#1e2d42] pb-2">{t('settings.appearance')}</h3>
      <div className="space-y-6">
        <div>
          <p className="text-xs font-medium text-[#c8daea] mb-1">{t('settings.language')}</p>
          <p className="text-xs text-[#7a9bb8] mb-3">{t('settings.languageDesc')}</p>
          <div className="flex gap-2">
            {[
              { value: 'zh', label: t('settings.languageZh') },
              { value: 'en', label: t('settings.languageEn') },
            ].map(({ value, label }) => (
              <button
                key={value}
                onClick={() => handleLanguageChange(value)}
                className={`px-4 py-1.5 text-xs rounded transition-colors ${
                  currentLang === value
                    ? 'bg-[#003d2f] text-white border border-[#00c9a7]'
                    : 'text-[#7a9bb8] border border-[#2a3f5a] hover:text-[#c8daea] hover:border-[#2a3f5a]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div>
          <p className="text-xs font-medium text-[#c8daea] mb-1">{t('settings.tablePageSizeLimit')}</p>
          <p className="text-xs text-[#7a9bb8] mb-3">{t('settings.tablePageSizeLimitDesc')}</p>
          <div className="flex flex-wrap gap-2">
            {PAGE_LIMIT_OPTIONS.map((size) => (
              <button
                key={size}
                onClick={() => setTablePageSizeLimit(size)}
                className={`px-4 py-1.5 text-xs rounded transition-colors ${
                  tablePageSizeLimit === size
                    ? 'bg-[#003d2f] text-white border border-[#00c9a7]'
                    : 'text-[#7a9bb8] border border-[#2a3f5a] hover:text-[#c8daea] hover:border-[#2a3f5a]'
                }`}
              >
                {size}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function PlaceholderSection({ title, description }: { title: string; description: string }) {
  return (
    <div className="w-full max-w-lg p-8 text-center text-[#7a9bb8]">
      <p className="text-sm font-medium text-[#c8daea] mb-2">{title}</p>
      <p className="text-xs">{description}</p>
    </div>
  );
}

function AboutSection({ t }: { t: any }) {
  return (
    <div className="w-full max-w-lg p-8 space-y-3">
      <h3 className="text-white font-semibold text-sm border-b border-[#1e2d42] pb-2">{t('settings.about')}</h3>
      <div className="space-y-2 text-xs text-[#7a9bb8]">
        <p><span className="text-[#c8daea]">{t('settings.appName')}</span>open-db-studio</p>
        <p><span className="text-[#c8daea]">{t('settings.positioning')}</span>AI-Native Database Client</p>
        <p><span className="text-[#c8daea]">{t('settings.techStack')}</span>Tauri 2.x · React 18 · Rust</p>
      </div>
    </div>
  );
}
