import { expect, test } from "@playwright/test";
import type { UIMessage, UIMessageChunk } from "ai";
import { z } from "zod";

test.use({ locale: "en-US" });

const requestFrame = z.object({
  type: z.literal("cf_agent_use_chat_request"),
  id: z.string(),
  init: z.object({ body: z.string() }),
});
const requestBody = z.object({ samReplyLanguage: z.string() });
const session = "sam-rtl-browser-fixture";
const technical =
  "pnpm run dev -- --host 127.0.0.1 " + "--strictPort ".repeat(35);
const reply = [
  "",
  "راجع إجمالي ١٢–٥٠ نقرة في Search Console، ثم افتح https://example.com/?a=1&b=2.",
  "",
  "This paragraph is English.",
  "",
  "7. افحص الصفحة الرئيسية.",
  "8. Keep the title short.",
  "   - بند فرعي",
  "",
  "| الصفحة | النقرات |",
  "| --- | --- |",
  "| الرئيسية | 123 |",
  "",
  "نفّذ `pnpm run dev` داخل /var/www/site.",
  "",
  "```bash",
  technical.trimEnd(),
  "```",
].join("\n");

const history: UIMessage[] = [
  {
    id: "history-user",
    role: "user",
    parts: [{ type: "text", text: "أرني تقرير SEO (١٢)." }],
  },
  {
    id: "history-assistant",
    role: "assistant",
    parts: [{ type: "text", text: "Here is your previous report." }],
  },
];

test("SAM shows a recoverable interruption after tool results", async ({
  page,
}) => {
  await page.route(`**/agents/sam-chat/${session}/get-messages*`, (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route(`**/agents/sam-chat/${session}/trace`, (route) =>
    route.fulfill({ status: 204 }),
  );
  const errorText =
    "انقطع رد سام. اطلب منه المتابعة من النتائج المتاحة أو أعد المحاولة.";
  let interrupt: (() => void) | undefined;
  await page.routeWebSocket(`**/agents/sam-chat/${session}*`, (socket) => {
    socket.onMessage((data) => {
      const frame = requestFrame.safeParse(JSON.parse(data.toString()));
      if (!frame.success) return;
      const send = (
        body: string,
        options?: { error?: boolean; done?: boolean },
      ) =>
        socket.send(
          JSON.stringify({
            type: "cf_agent_use_chat_response",
            id: frame.data.id,
            body,
            done: false,
            ...options,
          }),
        );
      const chunks: UIMessageChunk[] = [
        { type: "start", messageId: "partial-reply" },
        {
          type: "tool-input-available",
          toolName: "analyze_seo_project",
          toolCallId: "analysis",
          input: {},
        },
        {
          type: "tool-output-available",
          toolCallId: "analysis",
          output: { recommendations: [] },
        },
      ];
      for (const chunk of chunks) send(JSON.stringify(chunk));
      interrupt = () => {
        send(errorText, { error: true });
        send("", { done: true });
      };
    });
  });

  await page.goto("/");
  await page.waitForURL(/\/p\/[^/]+\/?$/, { timeout: 30_000 });
  const projectPath = new URL(page.url()).pathname.replace(/\/$/, "");
  await page.goto(`${projectPath}/sam?s=${session}`);
  const composer = page.getByRole("textbox");
  await composer.fill("حلّل أداء الكلمات المفتاحية");
  await composer.press("Enter");
  await expect.poll(() => Boolean(interrupt)).toBe(true);
  const result = page.getByText("SEO analysis complete · 0 recommendations", {
    exact: true,
  });
  await expect(result).toBeVisible();
  interrupt?.();

  const alert = page.getByRole("alert").filter({ hasText: errorText });
  await expect(alert).toHaveCSS("direction", "rtl");
  await expect(result).toBeVisible();
  await composer.fill("تابع من النتائج المتاحة");
  await expect(
    page.getByRole("button", { name: "Send message" }),
  ).toBeEnabled();
});

test("SAM keeps RTL text, streaming and preferences independent of dashboard direction", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1366, height: 1000 });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route(`**/agents/sam-chat/${session}/get-messages*`, (route) =>
    route.fulfill({ json: history }),
  );
  await page.route(`**/agents/sam-chat/${session}/trace`, (route) =>
    route.fulfill({ status: 204 }),
  );

  const preferences: string[] = [];
  let finishStream: (() => void) | undefined;
  await page.routeWebSocket(`**/agents/sam-chat/${session}*`, (socket) => {
    socket.onMessage((data) => {
      const frame = requestFrame.safeParse(JSON.parse(data.toString()));
      if (!frame.success) return;
      preferences.push(
        requestBody.parse(JSON.parse(frame.data.init.body)).samReplyLanguage,
      );
      const send = (chunk: UIMessageChunk, done = false) =>
        socket.send(
          JSON.stringify({
            type: "cf_agent_use_chat_response",
            id: frame.data.id,
            body: JSON.stringify(chunk),
            done,
          }),
        );
      const part = `text-${preferences.length}`;
      send({ type: "start", messageId: `assistant-${preferences.length}` });
      send({ type: "text-start", id: part });
      send({ type: "text-delta", id: part, delta: "## تحليل الأداء" });
      finishStream = () => {
        send({ type: "text-delta", id: part, delta: "\n" + reply });
        send({ type: "text-end", id: part });
        send({ type: "finish" }, true);
      };
    });
  });

  await page.goto("/");
  await page.waitForURL(/\/p\/[^/]+\/?$/, { timeout: 30_000 });
  const projectPath = new URL(page.url()).pathname.replace(/\/$/, "");
  await page.goto(`${projectPath}/sam?s=${session}`);

  const replyLanguage = page.getByRole("combobox", { name: "Reply language" });
  const layout = page.getByRole("combobox", { name: "SAM layout" });
  const composer = page.getByRole("textbox");
  await expect(replyLanguage).toHaveValue("auto");
  await expect(layout).toHaveValue("auto");
  await expect(composer).toHaveCSS("direction", "ltr");
  await expect(page.getByText("أرني تقرير SEO (١٢).")).toHaveCSS(
    "direction",
    "rtl",
  );
  await expect(page.getByText("Here is your previous report.")).toHaveCSS(
    "direction",
    "ltr",
  );

  await replyLanguage.selectOption("ar");
  await expect(composer).toHaveCSS("direction", "ltr");
  await composer.fill("حلّل نتائج SEO");
  await composer.press("End");
  await page.keyboard.insertText(" اليوم");
  await expect(composer).toHaveValue("حلّل نتائج SEO اليوم");
  await expect(composer).toHaveCSS("direction", "rtl");
  await composer.dispatchEvent("keydown", { key: "Enter", isComposing: true });
  await expect(composer).toHaveValue("حلّل نتائج SEO اليوم");
  await composer.press("Enter");
  await expect.poll(() => preferences).toEqual(["ar"]);
  await expect(page.getByRole("heading", { name: "تحليل الأداء" })).toHaveCSS(
    "direction",
    "rtl",
  );
  await expect(
    page.getByRole("button", { name: "Send message" }),
  ).toBeDisabled();
  finishStream?.();

  await expect(page.getByText("This paragraph is English.")).toHaveCSS(
    "direction",
    "ltr",
  );
  const range = page.getByText("١٢–٥٠", { exact: true });
  await expect(range).toHaveCSS("direction", "ltr");
  expect(
    await range.evaluate((element) => {
      const text = element.firstChild;
      if (!text) return false;
      const digit = document.createRange();
      digit.setStart(text, 0);
      digit.setEnd(text, 1);
      const start = digit.getBoundingClientRect().left;
      digit.setStart(text, 4);
      digit.setEnd(text, 5);
      return start < digit.getBoundingClientRect().left;
    }),
  ).toBe(true);
  await expect(page.locator("ol")).toHaveAttribute("start", "7");
  await expect(page.locator("ol")).toHaveCSS("direction", "rtl");
  await expect(page.locator("ol")).toHaveCSS("margin-right", "20px");
  await expect(page.getByText("Keep the title short.")).toHaveCSS(
    "text-align",
    "right",
  );
  await expect(page.locator("ol ul")).toHaveCSS("direction", "rtl");
  await expect(page.getByRole("table")).toHaveCSS("direction", "rtl");
  await expect(page.getByRole("cell", { name: "123" })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "https://example.com/?a=1&b=2" }),
  ).toHaveCSS("direction", "ltr");
  await expect(page.getByText("pnpm run dev", { exact: true })).toHaveCSS(
    "direction",
    "ltr",
  );
  await expect(page.locator("pre")).toHaveCSS("direction", "ltr");
  expect(
    await page
      .locator("pre")
      .evaluate((pre) => pre.scrollWidth > pre.clientWidth),
  ).toBe(true);

  await layout.selectOption("rtl");
  await expect(page.locator("html")).toHaveCSS("direction", "ltr");
  await expect(composer).toHaveAttribute("placeholder", /اطلب من سام/);
  const emptyHistory = page.getByText("No chats yet. Start a new one.", {
    exact: true,
  });
  if (await emptyHistory.isVisible()) {
    await expect(emptyHistory).toHaveCSS("direction", "ltr");
  }
  await page.screenshot({ path: testInfo.outputPath("sam-rtl-desktop.png") });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(layout).toHaveValue("rtl");
  await expect(replyLanguage).toHaveValue("ar");
  await expect(composer).toHaveCSS("direction", "rtl");
  const debugControl = page.getByRole("button", {
    name: "Clear history (dev)",
    exact: true,
  });
  if (await debugControl.isVisible()) {
    const previousReply = page.getByText("Here is your previous report.");
    const transcriptTop = await previousReply.evaluate(
      (element) =>
        element.closest(".overflow-y-auto")?.getBoundingClientRect().top,
    );
    const controlBounds = await debugControl.boundingBox();
    expect(controlBounds).not.toBeNull();
    if (controlBounds) {
      expect(controlBounds.y + controlBounds.height).toBeLessThanOrEqual(
        transcriptTop ?? 0,
      );
    }
  }
  await replyLanguage.selectOption("en");
  await expect(composer).toHaveAttribute("placeholder", /اطلب من سام/);
  await composer.fill("Please read this report.");
  await expect(composer).toHaveCSS("direction", "ltr");
  await composer.press("Enter");
  await expect.poll(() => preferences).toEqual(["ar", "en"]);
  await expect(page.getByRole("heading", { name: "تحليل الأداء" })).toHaveCSS(
    "direction",
    "rtl",
  );
  finishStream?.();
  await expect(page.getByRole("table")).toHaveCSS("direction", "rtl");
  expect(
    await page
      .locator("html")
      .evaluate((html) => html.scrollWidth <= html.clientWidth),
  ).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("sam-rtl-mobile.png") });

  expect(pageErrors).toEqual([]);
});

test("SAM keeps an RTL continuation and its generation status visible", async ({
  page,
}) => {
  const runId = "sam-rtl-generation-fixture";
  const user: UIMessage = {
    id: "request",
    role: "user",
    parts: [{ type: "text", text: "حلّل الكلمات المفتاحية" }],
  };
  const table = "| الكلمة | CTR |\n| --- | --- |\n| مثال | 2% |";
  const assistant: UIMessage = {
    id: "continued-answer",
    role: "assistant",
    parts: [
      {
        type: "tool-analyze_seo_project",
        toolCallId: "analysis",
        state: "output-available",
        input: {},
        output: { recommendations: [] },
      },
      { type: "text", text: table },
    ],
  };
  let completed = false;
  await page.route(`**/agents/sam-chat/${runId}/get-messages*`, (route) =>
    route.fulfill({ json: completed ? [user, assistant] : [] }),
  );
  await page.route(`**/agents/sam-chat/${runId}/trace`, (route) =>
    route.fulfill({ json: null }),
  );
  await page.routeWebSocket(`**/agents/sam-chat/${runId}*`, (socket) => {
    socket.onMessage((raw) => {
      const json: unknown = JSON.parse(raw.toString());
      const frame = requestFrame.safeParse(json);
      if (!frame.success) return;
      const send = (chunk: UIMessageChunk, done = false) =>
        socket.send(
          JSON.stringify({
            type: "cf_agent_use_chat_response",
            id: frame.data.id,
            body: JSON.stringify(chunk),
            done,
          }),
        );
      send({ type: "start", messageId: assistant.id });
      send({
        type: "tool-input-available",
        toolName: "analyze_seo_project",
        toolCallId: "analysis",
        input: {},
      });
      send({
        type: "tool-output-available",
        toolCallId: "analysis",
        output: { recommendations: [] },
      });
      send({ type: "text-start", id: "continued-text" });
      send({ type: "text-delta", id: "continued-text", delta: table });
      send({ type: "text-end", id: "continued-text" });
      completed = true;
      send({ type: "finish", finishReason: "stop" }, true);
      const events = [
        {
          event: "generation_request",
          metadata: {
            task: "comprehensive",
            stage: "analyze",
            effort: "high",
            target: 16384,
            requested: 16384,
          },
        },
        { event: "generation_finish", metadata: { finishReason: "length" } },
        {
          event: "generation_request",
          metadata: {
            task: "comprehensive",
            stage: "recover",
            effort: "low",
            target: 8192,
            requested: 8192,
            recoveryAttempts: 1,
          },
        },
        {
          event: "generation_finish",
          metadata: { finishReason: "stop", outputTokens: 235 },
        },
        {
          event: "generation_terminal",
          metadata: {
            status: "completed",
            modelSteps: 2,
            toolCalls: 1,
            recoveryAttempts: 1,
          },
        },
      ].map((event, index) => ({
        ...event,
        id: String(index),
        turnId: "turn",
        timestamp: index,
        sequence: index,
      }));
      socket.send(
        JSON.stringify({
          type: "sam_trace",
          turnId: "turn",
          ai: { provider: "Ollama Cloud", model: "glm-5.3" },
          events,
        }),
      );
    });
  });
  await page.goto("/");
  await page.waitForURL(/\/p\/[^/]+\/?$/, { timeout: 30_000 });
  const projectPath = new URL(page.url()).pathname.replace(/\/$/, "");
  await page.goto(`${projectPath}/sam?s=${runId}`);
  await page
    .getByRole("combobox", { name: "Reply language" })
    .selectOption("ar");
  const composer = page.getByRole("textbox");
  await composer.fill("حلّل الكلمات المفتاحية");
  await composer.press("Enter");
  const grid = page.getByRole("table");
  await expect(grid).toHaveCSS("direction", "rtl");
  await expect(
    grid.getByRole("columnheader").allTextContents(),
  ).resolves.toEqual(["الكلمة", "CTR"]);
  await page.getByRole("button", { name: "Trace", exact: true }).click();
  await page.getByText("Generation", { exact: true }).click();
  await expect(page.getByText("analyze / high → recover / low")).toBeVisible();
  await expect(page.getByText("Complete", { exact: true })).toBeVisible();
  await page.reload();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(grid).toHaveCSS("direction", "rtl");
  await expect(grid.getByRole("columnheader")).toHaveCount(2);
  await expect(
    page.getByText("SEO analysis complete · 0 recommendations"),
  ).toBeVisible();
});
