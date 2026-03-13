// src/utils/askAi.ts
import { useAiStore } from '../store/aiStore';
import { useAppStore } from '../store/appStore';

export function askAiWithContext(markdownContext: string): void {
  const { isChatting, clearHistory, setDraftMessage } = useAiStore.getState();
  const { setAssistantOpen } = useAppStore.getState();

  // 打开面板
  setAssistantOpen(true);

  // AI 忙碌 → clearHistory()（同时取消后端 ACP session，属于用户主动打断）
  if (isChatting) {
    clearHistory();
  }

  // 一次性填入输入框
  setDraftMessage(markdownContext);
}
