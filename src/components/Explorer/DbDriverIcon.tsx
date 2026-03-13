import React from 'react';
import { DatabaseZap } from 'lucide-react';

interface IconProps {
  size: number;
  className?: string;
}

// 统一描边属性，与 lucide-react 风格一致
const S = {
  fill: 'none' as const,
  stroke: 'currentColor',
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

// MySQL — 海豚侧面轮廓
// 特征：流线型身体 + 背鳍 + 尾叉
const MySQLIcon: React.FC<IconProps> = ({ size, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...S} strokeWidth={1.75}>
    {/* 身体轮廓 */}
    <path d="M4 15 C3 11 5 6.5 9 5 C13 3.5 18 5.5 19 9.5 C20 13 17 17 13 17.5 C10 18 7 17 4 15 Z" />
    {/* 背鳍 */}
    <path d="M14 5 L18.5 1.5 L20.5 6" />
    {/* 尾叉 */}
    <path d="M4 15 L1.5 19 L5 17.5" />
    <path d="M5 17.5 L5.5 21 L8 17" />
    {/* 眼睛 */}
    <circle cx="14.5" cy="10.5" r="1.2" fill="currentColor" stroke="none" />
  </svg>
);

// PostgreSQL — 大象头部（Slonik）
// 特征：圆形大头 + 扇形耳朵 + 弯曲象鼻
const PostgreSQLIcon: React.FC<IconProps> = ({ size, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...S} strokeWidth={1.75}>
    {/* 头部 */}
    <circle cx="11" cy="11" r="7.5" />
    {/* 耳朵 */}
    <path d="M4 7 C1.5 5 2 1.5 4 1.5 C5.5 1.5 6.5 3.5 6 6" />
    {/* 象鼻 */}
    <path d="M17 16 C20 15 22 17.5 22 20 C22 22 20.5 23.5 18.5 23.5 C16.5 23.5 15.5 22 15.5 20.5" />
    {/* 獠牙 */}
    <path d="M16 20 L17 24" strokeWidth={1.2} />
    {/* 眼睛 */}
    <circle cx="9" cy="9.5" r="1.2" fill="currentColor" stroke="none" />
  </svg>
);

// Oracle — 经典 O 形粗环（呼应官方椭圆徽标）
const OracleIcon: React.FC<IconProps> = ({ size, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...S} strokeWidth={3}>
    <circle cx="12" cy="12" r="8.5" />
  </svg>
);

// SQL Server — 三层圆柱体（描边风格）
const SqlServerIcon: React.FC<IconProps> = ({ size, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...S} strokeWidth={1.75}>
    {/* 顶部椭圆 */}
    <ellipse cx="12" cy="5" rx="8" ry="3" />
    {/* 左侧边 */}
    <line x1="4" y1="5" x2="4" y2="19" />
    {/* 右侧边 */}
    <line x1="20" y1="5" x2="20" y2="19" />
    {/* 中间分割线（半椭圆） */}
    <path d="M4 12 Q4 15 12 15 Q20 15 20 12" strokeOpacity={0.55} />
    {/* 底部椭圆 */}
    <ellipse cx="12" cy="19" rx="8" ry="3" />
  </svg>
);

// SQLite — 羽毛/叶片形状（SQLite 官方 logo 原型）
const SQLiteIcon: React.FC<IconProps> = ({ size, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...S} strokeWidth={1.75}>
    {/* 主体叶片 */}
    <path d="M12 2 C18 2 21 6 20 11 C19 16 16 19.5 12 20 C10 20 9 19 9 18 L9 22" />
    {/* 叶脉 / 羽轴 */}
    <path d="M9 22 L9 14" strokeOpacity={0.5} />
    {/* 左侧弧线收口 */}
    <path d="M9 14 C5 13 3 10 3 7.5 C3 4 6 2 12 2" />
  </svg>
);

// 对外统一入口
interface DbDriverIconProps {
  driver: string;
  size?: number;
  className?: string;
}

export const DbDriverIcon: React.FC<DbDriverIconProps> = ({ driver, size = 14, className = '' }) => {
  switch (driver) {
    case 'mysql':
      return <MySQLIcon size={size} className={className} />;
    case 'postgres':
      return <PostgreSQLIcon size={size} className={className} />;
    case 'oracle':
      return <OracleIcon size={size} className={className} />;
    case 'sqlserver':
      return <SqlServerIcon size={size} className={className} />;
    case 'sqlite':
      return <SQLiteIcon size={size} className={className} />;
    default:
      return <DatabaseZap size={size} className={className} />;
  }
};
