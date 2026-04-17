import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './i18n';
import App from './App.tsx';
import './index.css';
import './styles/ai-highlight.css';

// 全局过滤 Monaco Editor 的 "Canceled" Promise 错误（无害，编辑器卸载时的正常行为）
window.addEventListener('unhandledrejection', (event) => {
  if (event.reason?.name === 'Canceled' || String(event.reason) === 'Canceled: Canceled') {
    event.preventDefault();
  }
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// 启动画面超时兜底：如果 React 因资源加载失败未能挂载，10 秒后强制隐藏启动画面
const SPLASH_TIMEOUT = 10000;
const splashTimeout = setTimeout(() => {
  const splash = document.getElementById('splash');
  if (splash) {
    splash.classList.add('fade-out');
    setTimeout(() => splash.remove(), 500);
    console.error('[App] Splash timeout — resources may have failed to load');
  }
}, SPLASH_TIMEOUT);

// React 渲染完成后淡出启动画面
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    clearTimeout(splashTimeout);
    const splash = document.getElementById('splash');
    if (!splash) return;
    splash.classList.add('fade-out');
    splash.addEventListener('transitionend', () => splash.remove(), { once: true });
  });
});
