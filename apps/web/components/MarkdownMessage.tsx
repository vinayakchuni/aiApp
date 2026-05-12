'use client';

import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import type { Components } from 'react-markdown';

const components: Components = {
  img({ src, alt }) {
    if (typeof src !== 'string') return null;
    return (
      <img
        src={src}
        alt={alt ?? ''}
        className="my-2 max-w-full rounded border border-gray-200"
      />
    );
  },
  code({ className, children, ...rest }) {
    const match = /language-(\w+)/.exec(className || '');
    const codeString = String(children).replace(/\n$/, '');

    if (match) {
      return (
        <SyntaxHighlighter
          style={oneLight}
          language={match[1]}
          PreTag="div"
          className="!my-2 !rounded-md !text-sm"
        >
          {codeString}
        </SyntaxHighlighter>
      );
    }

    return (
      <code className="rounded bg-gray-100 px-1.5 py-0.5 text-sm" {...rest}>
        {children}
      </code>
    );
  },
};

interface Props {
  content: string;
}

export function MarkdownMessage({ content }: Props) {
  return (
    <div className="prose prose-sm max-w-none prose-headings:mt-3 prose-headings:mb-1 prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-pre:my-1 prose-pre:bg-transparent prose-pre:p-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={components}
        urlTransform={(url) =>
          url.startsWith('data:image/') ? url : defaultUrlTransform(url)
        }
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
