import { AlertTriangle } from 'lucide-react';
import { checkTypeCompatibility, type DialectName } from './dataTypes';
import { Tooltip } from '@/components/common/Tooltip';

interface CompatibilityWarningProps {
  typeName: string;
  dialect: DialectName | null;
}

export default function CompatibilityWarning({ typeName, dialect }: CompatibilityWarningProps) {
  if (!dialect) return null;
  const warning = checkTypeCompatibility(typeName, dialect);
  if (!warning) return null;
  return (
    <Tooltip content={warning}>
      <span className="inline-flex">
        <AlertTriangle size={12} className="text-[#f59e0b]" />
      </span>
    </Tooltip>
  );
}
