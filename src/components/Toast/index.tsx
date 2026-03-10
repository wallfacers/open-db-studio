import React from 'react';
import { Bell } from 'lucide-react';

interface ToastProps {
  message: string | null;
}

export const Toast: React.FC<ToastProps> = ({ message }) => {
  if (!message) return null;
  return (
    <div className="fixed top-6 left-1/2 -translate-x-1/2 bg-[#3794ff] text-white px-4 py-2 rounded shadow-lg z-50 transition-opacity flex items-center space-x-2">
      <Bell size={16} />
      <span>{message}</span>
    </div>
  );
};
