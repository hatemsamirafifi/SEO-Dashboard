import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { memo } from "react";
import ReactMarkdown, { type ExtraProps, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import { rehypeBidiMarkdown } from "@/client/components/chat/bidiMarkdown";

const BIDI_PLUGINS: Options["rehypePlugins"] = [rehypeBidiMarkdown];

type Props = {
  /** Raw Markdown source to render. */
  children: string;
  className?: string;
  bidi?: boolean;
};

/**
 * Shared Markdown renderer with explicit per-element Tailwind classes.
 *
 * OpenSEO doesn't ship `@tailwindcss/typography`, so `prose` classes are
 * no-ops — every block element is styled here instead. Tables use daisyUI's
 * `table table-sm` so model- and strategy-generated tables stay readable.
 *
 * Anchor URLs are sanitized to http(s) only — LLMs can be coaxed into
 * emitting `javascript:` payloads.
 *
 * Memoized on the markdown source: chat messages re-render on every store
 * notify (streaming coalesces at the throttle), and re-parsing remark syntax
 * for the whole accumulated text of a streaming part on every render was a
 * proven contributor to the streaming render storm. Settled text keeps its
 * string reference, so history pays the parse cost exactly once.
 */
export const Markdown = memo(function Markdown({
  children,
  className,
  bidi,
}: Props) {
  return (
    <div className={bidi ? `sam-bidi-markdown ${className ?? ""}` : className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={bidi ? BIDI_PLUGINS : undefined}
        components={MARKDOWN_COMPONENTS}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});

type AnchorProps = ComponentPropsWithoutRef<"a">;

function SafeAnchor({
  href,
  children,
  dir,
  node: _node,
  ...rest
}: AnchorProps & ExtraProps) {
  const safeHref = isHttpUrl(href) ? href : undefined;
  if (!safeHref) {
    return (
      <span dir={dir} className="underline decoration-dotted">
        {children}
      </span>
    );
  }
  return (
    <a
      {...rest}
      dir={dir}
      href={safeHref}
      target="_blank"
      rel="noreferrer"
      className="link link-primary"
    >
      {children}
    </a>
  );
}

function isHttpUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    // Mirror server-side `safeHttpUrl` — a `user:pass@host` URL shows one
    // hostname in link text while auth hits another.
    if (url.username || url.password) return false;
    return true;
  } catch {
    return false;
  }
}

type BlockProps = { children?: ReactNode; dir?: string };

export const MARKDOWN_COMPONENTS = {
  h1: ({ children, dir }: BlockProps) => (
    <h1 dir={dir} className="mt-5 mb-2 text-base font-semibold first:mt-0">
      {children}
    </h1>
  ),
  h2: ({ children, dir }: BlockProps) => (
    <h2 dir={dir} className="mt-5 mb-2 text-sm font-semibold first:mt-0">
      {children}
    </h2>
  ),
  h3: ({ children, dir }: BlockProps) => (
    <h3 dir={dir} className="mt-4 mb-1.5 text-sm font-semibold first:mt-0">
      {children}
    </h3>
  ),
  h4: ({ children, dir }: BlockProps) => (
    <h4 dir={dir} className="mt-3 mb-1 text-sm font-semibold first:mt-0">
      {children}
    </h4>
  ),
  p: ({ children, dir }: BlockProps) => (
    <p dir={dir} className="my-2 leading-relaxed first:mt-0 last:mb-0">
      {children}
    </p>
  ),
  ul: ({ children, dir }: BlockProps) => (
    <ul dir={dir} className="my-2 ms-5 list-disc space-y-1">
      {children}
    </ul>
  ),
  ol: ({ children, dir, start }: ComponentPropsWithoutRef<"ol">) => (
    <ol dir={dir} start={start} className="my-2 ms-5 list-decimal space-y-1">
      {children}
    </ol>
  ),
  li: ({ children }: { children?: ReactNode }) => (
    <li className="leading-relaxed">{children}</li>
  ),
  a: SafeAnchor,
  strong: ({ children }: { children?: ReactNode }) => (
    <strong className="font-semibold">{children}</strong>
  ),
  em: ({ children }: { children?: ReactNode }) => (
    <em className="italic">{children}</em>
  ),
  blockquote: ({ children, dir }: BlockProps) => (
    <blockquote
      dir={dir}
      className="my-2 border-s-2 border-base-300 ps-3 text-base-content/80 italic"
    >
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-3 border-base-300" />,
  code: ({ children, className, dir }: ComponentPropsWithoutRef<"code">) => {
    // Inline code (no `language-*` className from remark) gets the badge style;
    // block code is rendered by `pre` with a different shell.
    if (typeof className === "string" && className.startsWith("language-")) {
      return (
        <code dir={dir} className={className}>
          {children}
        </code>
      );
    }
    return (
      <code
        dir={dir}
        className="rounded bg-base-200 px-1 py-0.5 text-xs font-mono"
      >
        {children}
      </code>
    );
  },
  pre: ({ children, dir }: BlockProps) => (
    <pre
      dir={dir}
      className="my-2 overflow-x-auto rounded-lg bg-base-200 p-3 text-xs font-mono"
    >
      {children}
    </pre>
  ),
  table: ({ children, dir }: BlockProps) => (
    <div dir={dir} className="my-3 overflow-x-auto">
      <table dir={dir} className="table table-sm border border-base-300">
        {children}
      </table>
    </div>
  ),
  thead: ({ children }: { children?: ReactNode }) => <thead>{children}</thead>,
  tbody: ({ children }: { children?: ReactNode }) => <tbody>{children}</tbody>,
  tr: ({ children }: { children?: ReactNode }) => (
    <tr className="border-b border-base-300 last:border-0">{children}</tr>
  ),
  th: ({ children, dir, style }: ComponentPropsWithoutRef<"th">) => (
    <th
      dir={dir}
      style={style}
      className="px-2 py-1.5 text-start font-semibold"
    >
      {children}
    </th>
  ),
  td: ({ children, dir, style }: ComponentPropsWithoutRef<"td">) => (
    <td dir={dir} style={style} className="px-2 py-1.5 align-top">
      {children}
    </td>
  ),
};
