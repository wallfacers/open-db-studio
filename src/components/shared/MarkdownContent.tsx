import React, { useState, useCallback, memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Copy, Check } from 'lucide-react';

// ── 代码块 ──────────────────────────────────────────────────────────────────
const CodeBlock: React.FC<{ language: string; code: string }> = memo(({ language, code }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [code]);

  return (
    <div className="my-2 rounded overflow-hidden border border-[#1e2d42]">
      <div className="flex items-center justify-between px-3 py-1.5 bg-[#161b22] border-b border-[#1e2d42]">
        <span className="text-xs text-[#7a9bb8] font-mono">{language || 'plaintext'}</span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 text-xs text-[#7a9bb8] hover:text-[#c8daea] transition-colors"
        >
          {copied ? (
            <><Check size={12} className="text-[#00c9a7]" /><span className="text-[#00c9a7]">已复制</span></>
          ) : (
            <><Copy size={12} /><span>复制</span></>
          )}
        </button>
      </div>
      <SyntaxHighlighter
        style={oneDark}
        language={language || 'plaintext'}
        useInlineStyles={false}
        PreTag="div"
        customStyle={{ margin: 0, borderRadius: 0, fontSize: '12px', background: '#0d1117', padding: '12px', overflowX: 'auto' }}
        codeTagProps={{ style: { background: 'transparent' } }}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
});

// ── Markdown 渲染器（已完成消息专用，用 memo 防止无关重渲染）───────────────
const mdComponents = {
  code({ className, children, ...props }: React.ComponentPropsWithoutRef<'code'> & { className?: string }) {
    const match = /language-(\w+)/.exec(className ?? '');
    const language = match ? match[1] : '';
    if (match) {
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

export const MarkdownContent: React.FC<{ content: string }> = memo(({ content }) => (
  <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
    {content}
  </ReactMarkdown>
));
