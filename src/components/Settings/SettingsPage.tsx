import React, { useState } from 'react';
import { Bot, Keyboard, Palette, Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { LlmSettingsPanel } from './LlmSettings';

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
    <div className="flex-1 flex min-w-0 bg-[#1e1e1e]">
      {/* 左侧导航 */}
      <div className="w-48 flex-shrink-0 bg-[#181818] border-r border-[#2b2b2b] pt-4">
        <div className="px-4 pb-3 text-xs text-[#858585] font-medium uppercase tracking-wider">{t('settings.title')}</div>
        {NAV_ITEMS.map(({ id, icon: Icon, label }) => (
          <button
            key={id}
            className={`w-full flex items-center px-4 py-2 text-sm text-left transition-colors ${
              activeSection === id
                ? 'bg-[#094771] text-white border-l-2 border-[#3794ff]'
                : 'text-[#858585] hover:text-[#d4d4d4] hover:bg-[#2a2a2a] border-l-2 border-transparent'
            }`}
            onClick={() => setActiveSection(id)}
          >
            <Icon size={15} className="mr-2.5 flex-shrink-0" />
            {label}
          </button>
        ))}
      </div>

      {/* 右侧内容 */}
      <div className="flex-1 overflow-y-auto">
        {activeSection === 'ai' && <LlmSettingsPanel />}
        {activeSection === 'appearance' && (
          <PlaceholderSection title={t('settings.appearance')} description={t('settings.appearanceDesc')} />
        )}
        {activeSection === 'shortcuts' && (
          <PlaceholderSection title={t('settings.shortcuts')} description={t('settings.shortcutsDesc')} />
        )}
        {activeSection === 'about' && <AboutSection t={t} />}
      </div>
    </div>
  );
}

function PlaceholderSection({ title, description }: { title: string; description: string }) {
  return (
    <div className="p-8 text-center text-[#858585]">
      <p className="text-sm font-medium text-[#d4d4d4] mb-2">{title}</p>
      <p className="text-xs">{description}</p>
    </div>
  );
}

function AboutSection({ t }: { t: any }) {
  return (
    <div className="p-6 space-y-3 max-w-lg">
      <h3 className="text-white font-semibold text-sm border-b border-[#2b2b2b] pb-2">{t('settings.about')}</h3>
      <div className="space-y-2 text-xs text-[#858585]">
        <p><span className="text-[#d4d4d4]">{t('settings.appName')}</span>open-db-studio</p>
        <p><span className="text-[#d4d4d4]">{t('settings.positioning')}</span>AI-Native Database Client</p>
        <p><span className="text-[#d4d4d4]">{t('settings.techStack')}</span>Tauri 2.x · React 18 · Rust</p>
      </div>
    </div>
  );
}
