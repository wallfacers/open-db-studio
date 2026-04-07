import React, { createContext, useContext } from 'react';

interface ChatConnectionInfo {
  connectionId: number | null;
  database?: string;
  schema?: string;
}

const ChatConnectionContext = createContext<ChatConnectionInfo>({
  connectionId: null,
});

export const ChatConnectionProvider = ChatConnectionContext.Provider;

export function useChatConnection(): ChatConnectionInfo {
  return useContext(ChatConnectionContext);
}
