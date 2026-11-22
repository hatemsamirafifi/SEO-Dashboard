import type { UIMessage } from "ai";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatMessage, humanizeToolLabel } from "./ChatMessage";
import { Markdown } from "@/client/components/Markdown";

describe("SAM bidirectional messages", () => {
  it("detects Arabic and English turns and leaves user text intact", () => {
    const message: UIMessage = {
      id: "user",
      role: "user",
      parts: [{ type: "text", text: "راجع /var/www/site، ثم افحص SEO (١٢)." }],
    };
    const user = renderToStaticMarkup(
      <ChatMessage
        message={message}
        resolveToolLabel={humanizeToolLabel}
        bidi
      />,
    );
    expect(user).toContain('dir="auto"');
    expect(user).toContain(
      'راجع <bdi dir="ltr">/var/www/site</bdi>، ثم افحص SEO (١٢).',
    );

    const english = renderToStaticMarkup(
      <ChatMessage
        message={{
          ...message,
          role: "assistant",
          parts: [{ type: "text", text: "Review SEO now." }],
        }}
        resolveToolLabel={humanizeToolLabel}
        bidi
      />,
    );
    expect(english).toMatch(/^<div dir="ltr"/);
  });

  it("renders Arabic and English blocks, mixed lists, and ordered list offsets", () => {
    const html = renderToStaticMarkup(
      <Markdown bidi>
        {[
          "# تقرير الأداء",
          "This paragraph is English.",
          "7. عنصر عربي أول\n8. English item\n   - بند فرعي",
          "- قائمة عربية\n- بند آخر",
          "> راجع أداء SEO (١٢).",
        ].join("\n\n")}
      </Markdown>,
    );
    expect(html).toMatch(/<h1 dir="auto"[^>]*>تقرير الأداء/);
    expect(html).toMatch(/<p dir="auto"[^>]*>This paragraph is English/);
    expect(html).toMatch(/<ol dir="rtl" start="7"/);
    expect(html).toMatch(/<li[^>]*><div dir="auto">English item\s*<\/div>/);
    expect(html.match(/<ul dir="rtl"/g)).toHaveLength(2);
    expect(html).toMatch(/<blockquote dir="rtl"/);
  });

  it("keeps table columns in reading order and isolates technical text", () => {
    const html = renderToStaticMarkup(
      <Markdown bidi>
        {[
          "| الصفحة | Clicks |\n| --- | ---: |\n| الرئيسية | 123 |",
          "افتح https://example.com/?a=1&b=2 ثم نفّذ `pnpm run dev`.",
          "افتح [دليل التحليل](https://example.com/guide)، واقرأ src/routes/sam.tsx خلال ١٢–٥٠ يومًا.",
          "افتح [رابط غير صالح](javascript:alert%281%29).",
          "```bash\ncat /var/www/site\n```",
        ].join("\n\n")}
      </Markdown>,
    );
    expect(html).toMatch(/<table dir="rtl"/);
    expect(html).toMatch(/<th dir="auto"[^>]*>الصفحة/);
    expect(html).toMatch(/<td style="text-align:right"[^>]*>123/);
    expect(html).toMatch(
      /<a [^>]*dir="ltr"[^>]*href="https:\/\/example.com\/\?a=1&amp;b=2"/,
    );
    expect(html).toMatch(
      /<a [^>]*href="https:\/\/example.com\/guide"[^>]*>دليل التحليل/,
    );
    expect(html).toContain('<bdi dir="ltr">src/routes/sam.tsx</bdi>');
    expect(html).toContain('<bdo dir="ltr">١٢–٥٠</bdo>');
    expect(html).not.toContain("javascript:");
    expect(html).toMatch(/<code dir="ltr"[^>]*>pnpm run dev<\/code>/);
    expect(html).toMatch(
      /<pre dir="ltr"[^>]*><code class="language-bash">cat \/var\/www\/site/,
    );
  });

  it("renders a tool result detail and each new streaming snapshot", () => {
    function renderStreaming(text: string) {
      return renderToStaticMarkup(
        <ChatMessage
          message={{
            id: "assistant",
            role: "assistant",
            parts: [
              {
                type: "tool-research",
                state: "output-available",
                toolCallId: "one",
                input: {},
                output: { location: "القاهرة /api/report" },
              },
              { type: "text", state: "streaming", text },
            ],
          }}
          resolveToolLabel={() => ({
            running: "Researching",
            done: "Research complete",
            detail: () => "القاهرة /api/report",
          })}
          streaming
          bidi
        />,
      );
    }
    expect(renderStreaming("…")).not.toContain('dir="rtl"');
    const arabic = renderStreaming("… النتائج المتاحة");
    expect(arabic).toMatch(/^<div dir="rtl"/);
    expect(arabic).toContain('القاهرة <bdi dir="ltr">/api/report</bdi>');
    expect(arabic).not.toContain("Copy message");
  });
});
