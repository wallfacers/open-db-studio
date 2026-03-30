import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './i18n';
import App from './App.tsx';
import './index.css';

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

// React 渲染完成后淡出启动画面
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    const splash = document.getElementById('splash');
    if (!splash) return;
    splash.classList.add('fade-out');
    splash.addEventListener('transitionend', () => splash.remove(), { once: true });
  });
});
