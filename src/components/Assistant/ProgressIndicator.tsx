import React from 'react';
import { Check, Loader2 } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import type { ToolStep } from '../../store/aiStore';

interface ProgressIndicatorProps {
  steps: ToolStep[];
}

export const ProgressIndicator: React.FC<ProgressIndicatorProps> = ({ steps }) => {
  if (steps.length === 0) return null;

  return (
    <div className="mb-2 space-y-0.5">
      <AnimatePresence mode="popLayout">
        {steps.map((step, i) => (
          <motion.div
            key={`${step.name}-${i}`}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="flex items-center gap-1.5 text-[11px]"
          >
            {step.status === 'done' ? (
              <Check size={10} className="text-accent flex-shrink-0" />
            ) : step.status === 'active' ? (
              <Loader2 size={10} className="text-accent animate-spin flex-shrink-0" />
            ) : (
              <span className="w-2.5 h-2.5 rounded-full border border-border-default flex-shrink-0" />
            )}
            <span className={`truncate ${
              step.status === 'active'
                ? 'text-foreground-default'
                : step.status === 'done'
                  ? 'text-foreground-ghost'
                  : 'text-foreground-ghost'
            }`}>
              {step.name}
              {step.description && (
                <span className="text-foreground-ghost ml-1">— {step.description}</span>
              )}
            </span>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
};
