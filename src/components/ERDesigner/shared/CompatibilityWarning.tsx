import { AlertTriangle } from 'lucide-react';
import { checkTypeCompatibility, type DialectName } from './dataTypes';

interface CompatibilityWarningProps {
  typeName: string;
  dialect: DialectName | null;
}

export default function CompatibilityWarning({ typeName, dialect }: CompatibilityWarningProps) {
  if (!dialect) return null;
  const warning = checkTypeCompatibility(typeName, dialect);
  if (!warning) return null;
  return (
    <span className="relative group" title={warning}>
      <AlertTriangle size={12} className="text-[#f59e0b]" />
    </span>
  );
}
