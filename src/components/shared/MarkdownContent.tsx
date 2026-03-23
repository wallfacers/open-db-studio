import React, { useState, useCallback, memo } from 'react';
import ReactDOM from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Copy, Check, Maximize2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ChartBlock } from './ChartBlock';
import { Tooltip } from '../common/Tooltip';

// ── 代码放大弹框 ─────────────────────────────────────────────────────────────
const CodeExpandModal: React.FC<{
  language: string;
  code: string;
  onClose: () => void;
}> = memo(({ language, code, onClose }) => {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // 全文统一使用 React.useEffect 命名空间风格（与 CodeBlock 保持一致）
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('keydown', handler);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [onClose]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // 静默失败
    }
  }, [code]);

  return ReactDOM.createPortal(
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center bg-black/70"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-[#111922] border border-[#253347] rounded-lg shadow-2xl w-[90vw] max-w-5xl max-h-[85vh] flex flex-col overflow-hidden">
        {/* 弹框头部 */}
        <div className="flex items-center justify-between px-4 py-2.5 bg-[#161b22] border-b border-[#1e2d42] flex-shrink-0">
          <span className="text-xs text-[#7a9bb8] font-mono">{language || 'plaintext'}</span>
          <div className="flex items-center gap-3">
            <button
              onClick={handleCopy}
              className="flex items-center gap-1 text-xs text-[#7a9bb8] hover:text-[#c8daea] transition-colors"
            >
              {copied ? (
                <><Check size={13} className="text-[#00c9a7]" /><span className="text-[#00c9a7]">{t('commonComponents.markdownContent.copied')}</span></>
              ) : (
                <><Copy size={13} /><span>{t('commonComponents.markdownContent.copy')}</span></>
              )}
            </button>
            <Tooltip content={t('commonComponents.markdownContent.close')} className="contents">
              <button
                onClick={onClose}
                className="text-[#7a9bb8] hover:text-[#c8daea] transition-colors"
              >
                <X size={16} />
              </button>
            </Tooltip>
          </div>
        </div>
        {/* 代码区域：overflow-auto 覆盖横纵两个方向 */}
        <div className="flex-1 overflow-auto">
          <SyntaxHighlighter
            style={oneDark}
            language={language || 'plaintext'}
            useInlineStyles={true}
            PreTag="div"
            customStyle={{ margin: 0, borderRadius: 0, fontSize: '12px', background: '#0d1117', padding: '12px', minHeight: '100%', overflowX: 'auto' }}
            codeTagProps={{ style: { background: 'transparent' } }}
          >
            {code}
          </SyntaxHighlighter>
        </div>
      </div>
    </div>,
    document.body
  );
});

// ── 代码块 ───────────────────────────────────────────────────────────────────
const CodeBlock: React.FC<{ language: string; code: string }> = memo(({ language, code }) => {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, []);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard 不可用时静默失败
    }
  }, [code]);

  const handleClose = useCallback(() => setExpanded(false), []);

  return (
    <>
      <div className="my-2 rounded overflow-hidden border border-[#1e2d42]">
        <div className="flex items-center justify-between px-3 py-1.5 bg-[#161b22] border-b border-[#1e2d42]">
          <span className="text-xs text-[#7a9bb8] font-mono">{language || 'plaintext'}</span>
          <div className="flex items-center gap-3">
            <Tooltip content={t('commonComponents.markdownContent.expandView')} className="contents">
              <button
                onClick={() => setExpanded(true)}
                className="flex items-center gap-1 text-xs text-[#7a9bb8] hover:text-[#c8daea] transition-colors"
              >
                <Maximize2 size={12} />
              </button>
            </Tooltip>
            <button
              onClick={handleCopy}
              className="flex items-center gap-1 text-xs text-[#7a9bb8] hover:text-[#c8daea] transition-colors"
            >
              {copied ? (
                <><Check size={12} className="text-[#00c9a7]" /><span className="text-[#00c9a7]">{t('commonComponents.markdownContent.copied')}</span></>
              ) : (
                <><Copy size={12} /><span>{t('commonComponents.markdownContent.copy')}</span></>
              )}
            </button>
          </div>
        </div>
        <SyntaxHighlighter
          style={oneDark}
          language={language || 'plaintext'}
          useInlineStyles={true}
          PreTag="div"
          customStyle={{ margin: 0, borderRadius: 0, fontSize: '12px', background: '#0d1117', padding: '12px', overflowX: 'auto' }}
          codeTagProps={{ style: { background: 'transparent' } }}
        >
          {code}
        </SyntaxHighlighter>
      </div>
      {expanded && (
        <CodeExpandModal
          language={language}
          code={code}
          onClose={handleClose}
        />
      )}
    </>
  );
});

// ── Markdown 渲染器组件工厂（根据 isStreaming 生成不同的 code 渲染器）─────────
function makeMdComponents(isStreaming: boolean) {
  return {
  code({ className, children, ...props }: React.ComponentPropsWithoutRef<'code'> & { className?: string }) {
    const match = /language-(\w+)/.exec(className ?? '');
    const language = match ? match[1] : '';
    if (match) {
      if (language === 'chart') {
        return <ChartBlock code={String(children).replace(/\n$/, '')} isStreaming={isStreaming} />;
      }
      return <CodeBlock language={language} code={String(children).replace(/\n$/, '')} />;
    }
    return (
      <code className="bg-[#111922] text-[#569cd6] px-1 py-0.5 rounded text-xs font-mono" {...props}>
        {children}
      </code>
    );
  },
  p({ children }: React.ComponentPropsWithoutRef<'p'>) {
    return <p className="leading-relaxed mb-2 last:mb-0">{children}</p>;
  },
  ul({ children }: React.ComponentPropsWithoutRef<'ul'>) {
    return <ul className="list-disc list-inside space-y-1 mb-2 pl-2">{children}</ul>;
  },
  ol({ children }: React.ComponentPropsWithoutRef<'ol'>) {
    return <ol className="list-decimal list-inside space-y-1 mb-2 pl-2">{children}</ol>;
  },
  li({ children }: React.ComponentPropsWithoutRef<'li'>) {
    return <li className="text-[#c8daea]">{children}</li>;
  },
  h1({ children }: React.ComponentPropsWithoutRef<'h1'>) {
    return <h1 className="text-base font-semibold text-[#e8f4fd] mb-2 mt-3 first:mt-0">{children}</h1>;
  },
  h2({ children }: React.ComponentPropsWithoutRef<'h2'>) {
    return <h2 className="text-sm font-semibold text-[#e8f4fd] mb-2 mt-3 first:mt-0">{children}</h2>;
  },
  h3({ children }: React.ComponentPropsWithoutRef<'h3'>) {
    return <h3 className="text-sm font-medium text-[#e8f4fd] mb-1 mt-2 first:mt-0">{children}</h3>;
  },
  strong({ children }: React.ComponentPropsWithoutRef<'strong'>) {
    return <strong className="font-semibold text-[#e8f4fd]">{children}</strong>;
  },
  blockquote({ children }: React.ComponentPropsWithoutRef<'blockquote'>) {
    return <blockquote className="border-l-2 border-[#2a3f5a] pl-3 text-[#7a9bb8] italic my-2">{children}</blockquote>;
  },
  table({ children }: React.ComponentPropsWithoutRef<'table'>) {
    return (
      <div className="overflow-x-auto my-2">
        <table className="text-xs border-collapse w-full">{children}</table>
      </div>
    );
  },
  th({ children }: React.ComponentPropsWithoutRef<'th'>) {
    return <th className="border border-[#1e2d42] bg-[#111922] px-2 py-1 text-left font-medium text-[#c8daea]">{children}</th>;
  },
  td({ children }: React.ComponentPropsWithoutRef<'td'>) {
    return <td className="border border-[#1e2d42] px-2 py-1 text-[#c8daea]">{children}</td>;
  },
  };
}

const staticMdComponents = makeMdComponents(false);
const streamingMdComponents = makeMdComponents(true);

/** 确保围栏代码块（```）总在行首，避免 AI 输出"文字。```chart" 导致图表无法渲染 */
function ensureCodeFenceOnNewLine(content: string): string {
  return content.replace(/([^\n])(```)/g, '$1\n$2');
}

export const MarkdownContent: React.FC<{ content: string; isStreaming?: boolean }> = memo(({ content, isStreaming = false }) => {
  const components = isStreaming ? streamingMdComponents : staticMdComponents;
  const processed = ensureCodeFenceOnNewLine(content);
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {processed}
    </ReactMarkdown>
  );
});
