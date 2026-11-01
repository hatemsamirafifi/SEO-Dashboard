# Upstream Sync & Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port high-value upstream enhancements from OpenSEO (`every-app/open-seo`) into `SEO-Dashboard`: Worker heap & ASCII bundling optimizations, site audit false-broken-link & word-count hardening, IndexNow search engine submission service & MCP tool, and Google Search Console & GA4 MCP binding tools.

**Architecture:** Port each feature cleanly into existing patterns without disturbing custom migrations (Wave 1-3 speckit, Google Ads). Schema changes for IndexNow follow project conventions with sequential SQLite (`0076`) and Postgres (`0054`) migrations. New MCP tools register cleanly into `registerOpenSeoMcpTools`.

**Tech Stack:** TypeScript, Cloudflare Workers, TanStack Router/Query, Drizzle ORM (SQLite/D1 & Postgres), Vite, Vitest, Zod 4.6.7, Model Context Protocol (MCP) SDK.

**Spec:** Porting verified upstream commits: `8c15b1e1`, `8a8cf897`, `3cfa13e2`, `756538cc`, `6dcb3865`, `9b2ca23b`, `b41c08ae`, `b76ba8e0`, `491cf063`.

## Global Constraints

- Never run a direct `git merge upstream/main` because upstream restructured migrations into `drizzle/sqlite` and `drizzle/pg`, while this repository has custom migrations through `0075` in `drizzle/`.
- All database modifications must be dual-dialect: SQLite (`drizzle/`) and PostgreSQL (`drizzle-pg/`).
- TypeScript checks must pass cleanly with `tsc --noEmit`.
- Preserve existing comments and docstrings.

## Review Focus

1. `url-utils`: Ensure `/cdn-cgi/l/email-protection` is ignored by crawler so false broken link issues are eliminated without suppressing real pages.
2. `page-analyzer`: Ensure minified HTML block tags (like `<p>one</p><p>two</p>`) do not collapse into single word "onetwo", and CJK/Thai character scripts count word segments correctly using `Intl.Segmenter`.
3. `IndexNowService`: Ensure keys are generated with 32 hex chars, key verification checks root `/{key}.txt`, and rate limiting falls back to secondary engines (Yandex/Yep).
4. `google-connection-tools`: Ensure non-admin users or users without integration permissions are rejected (`requireOrgPermission`), and selected properties/sites are marked with `isSelected`.
5. Worker heap: Verify `esbuild.charset = "ascii"` and `generateBundle` escaping transforms non-ASCII characters to prevent V8 two-byte string representation heap ballooning.

---

### Task 1: Worker Heap & Memory Optimization (Zod 4.6.7 & ASCII Bundling)

**Files:**
- Modify: `package.json`
- Modify: `vite.config.ts:70-90`
- Modify: `vite-plugin-lean-worker-bundle.ts:150-175`

**Interfaces:**
- Produces: `package.json` overrides for `zod@4` set to `4.6.7`, pure ASCII bundles from Vite/esbuild to keep module source representation at 1 byte per char in V8.

- [ ] **Step 1: Update package.json dependencies and overrides**

In `package.json`:
Update `"zod": "^4.1.12"` to `"zod": "^4.6.7"`.
Add pnpm overrides:
```json
  "pnpm": {
    "overrides": {
      "zod@4": "4.6.7"
    }
  }
```

- [ ] **Step 2: Add esbuild ASCII charset in vite.config.ts**

In `vite.config.ts`, inside `defineConfig`:
```typescript
    esbuild: {
      // Emit every chunk as pure ASCII: esbuild rewrites each non-ASCII
      // character in string, regex, and identifier tokens as a \uXXXX escape.
      // V8 stores files containing characters outside Latin-1 at 2 bytes per char,
      // which doubles the worker chunk memory from 7.8MB to 15.5MB in the 128MB isolate heap.
      charset: "ascii",
    },
```

- [ ] **Step 3: Add ASCII comment escaping in vite-plugin-lean-worker-bundle.ts**

In `vite-plugin-lean-worker-bundle.ts` inside `generateBundle`:
```typescript
      if (environment !== "client") {
        for (const output of Object.values(bundle)) {
          if (output.type !== "chunk") continue;
          output.code = output.code.replace(
            /[\u0080-\uffff]/g,
            (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`,
          );
        }
      }
```

- [ ] **Step 4: Verify typecheck passes**

Run: `cmd /c "pnpm exec tsc --noEmit"`
Expected: PASS with 0 errors.

- [ ] **Step 5: Commit changes**

```bash
git add package.json vite.config.ts vite-plugin-lean-worker-bundle.ts
git commit -m "perf(worker): upgrade zod to 4.6.7 and enforce ascii bundles to cut isolate heap"
```

---

### Task 2: Site Audit Resilience & GSC Date Range Window Fix

**Files:**
- Modify: `src/server/lib/audit/url-utils.ts`
- Modify: `src/server/lib/audit/url-utils.test.ts`
- Modify: `src/server/lib/audit/page-analyzer.ts`
- Modify: `src/server/lib/audit/page-analyzer.test.ts`
- Modify: `src/client/features/audit/results/IssuesView.tsx`
- Modify: `src/server/mcp/tools/site-audit-tools.ts`
- Modify: `src/server/features/gsc/searchAnalytics.ts:90-105`
- Modify: `src/server/features/gsc/searchAnalytics.test.ts:15-30`

**Interfaces:**
- Produces: `isAuditablePageUrl` returning `false` for `/cdn-cgi/` paths.
- Produces: `analyzeHtml` properly spacing block tags in minified HTML and segmenting CJK tokens.
- Produces: `resolveDateRange` producing exact inclusive 7-day and 28-day windows.

- [ ] **Step 1: Write the failing tests in url-utils.test.ts, page-analyzer.test.ts, and searchAnalytics.test.ts**

In `src/server/lib/audit/url-utils.test.ts`:
Add test case:
```typescript
    ["https://example.com/cdn-cgi/l/email-protection", undefined, false],
```

In `src/server/lib/audit/page-analyzer.test.ts`:
Add tests for word boundary between block elements and CJK scripts:
```typescript
describe("analyzeHtml word count", () => {
  const analyzeBody = (body: string) =>
    analyzeHtml(`<body>${body}</body>`, "https://example.com", 200, 0);

  it("keeps word boundaries between paragraphs in minified HTML", () => {
    expect(analyzeBody("<p>one</p><p>two</p>").bodyText).toBe("one two");
  });

  it("counts words in scripts written without spaces", () => {
    expect(
      analyzeBody("<p>吉隆坡市中心永久地契公寓投资指南</p>").wordCount,
    ).toBe(8);
  });
});
```

In `src/server/features/gsc/searchAnalytics.test.ts`:
Update `resolveDateRange` test to verify exact inclusive 7-day and 28-day windows:
```typescript
  it.each([
    { dateRange: "last_7_days" as const, startDate: "2026-05-19" },
    { dateRange: "last_28_days" as const, startDate: "2026-04-28" },
  ])(
    "computes an inclusive $dateRange window from the lagged end",
    ({ dateRange, startDate }) => {
      expect(resolveDateRange({ dateRange }, TODAY)).toEqual({
        startDate,
        endDate: "2026-05-25",
      });
    },
  );
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cmd /c "pnpm vitest run src/server/lib/audit/url-utils.test.ts src/server/lib/audit/page-analyzer.test.ts src/server/features/gsc/searchAnalytics.test.ts"`
Expected: FAIL on the new/updated test cases.

- [ ] **Step 3: Implement url-utils.ts, page-analyzer.ts, and searchAnalytics.ts updates**

In `src/server/lib/audit/url-utils.ts`:
```typescript
  if (NON_DOCUMENT_EXTENSIONS.test(parsed.pathname)) return false;
  if (parsed.pathname.startsWith("/cdn-cgi/")) return false;
```

In `src/server/lib/audit/page-analyzer.ts`:
Add `BLOCK_TAGS` Set, `SPACELESS_SCRIPT` regex, `wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" })`, `countWords(text: string)`, and update `onopentag`/`onclosetag` to inject space for block tags when `bodyDepth > 0`.

In `src/server/features/gsc/searchAnalytics.ts`:
```typescript
// GSC treats both startDate and endDate as inclusive, so an N-day window starts N-1 days before the end.
function subtractRange(end: Date, range: GscDateRange): Date {
  const d = new Date(end);
  switch (range) {
    case "last_7_days":
      d.setUTCDate(d.getUTCDate() - 6);
      break;
    case "last_28_days":
    case "custom":
      d.setUTCDate(d.getUTCDate() - 27);
      break;
    case "last_30_days":
      d.setUTCDate(d.getUTCDate() - 29);
      break;
```

Update `src/client/features/audit/results/IssuesView.tsx`:
Change empty state title to `"No issues found."` and description to `"Every crawled page passed the issue checks."`.

Update `src/server/mcp/tools/site-audit-tools.ts`:
Update `getAuditIssuesTool` empty issue copy for running vs completed audits.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cmd /c "pnpm vitest run src/server/lib/audit/url-utils.test.ts src/server/lib/audit/page-analyzer.test.ts src/server/features/gsc/searchAnalytics.test.ts"`
Expected: PASS.

- [ ] **Step 5: Commit changes**

```bash
git add src/server/lib/audit/url-utils.ts src/server/lib/audit/url-utils.test.ts src/server/lib/audit/page-analyzer.ts src/server/lib/audit/page-analyzer.test.ts src/client/features/audit/results/IssuesView.tsx src/server/mcp/tools/site-audit-tools.ts
git commit -m "fix(audit): ignore cloudflare cdn-cgi links and fix cjk minified html word count"
```

---

### Task 3: IndexNow Integration (Schema, Service, and MCP Tool)

**Files:**
- Modify: `src/db/app.schema.ts`
- Modify: `src/db/pg/app.schema.ts`
- Create: `drizzle/0076_indexnow_key.sql`
- Create: `drizzle-pg/0054_indexnow_key.sql`
- Modify: `src/server/features/projects/repositories/ProjectRepository.ts`
- Create: `src/types/schemas/indexnow.ts`
- Create: `src/server/features/indexnow/services/IndexNowService.ts`
- Create: `src/server/features/indexnow/services/IndexNowService.test.ts`
- Create: `src/server/mcp/tools/submit-indexnow-urls.ts`
- Modify: `src/server/mcp/server.ts`
- Create: `src/serverFunctions/indexnow.ts`

**Interfaces:**
- Produces: `IndexNowService.submitUrls({ projectId, organizationId }, urls: string[])`
- Produces: MCP Tool `submit_indexnow_urls` registered on MCP server.

- [ ] **Step 1: Add schema field and migrations for indexnowKey**

In `src/db/app.schema.ts`:
Add `indexnowKey: text("indexnow_key")` to `projects`.

In `src/db/pg/app.schema.ts`:
Add `indexnowKey: text("indexnow_key")` to `projects`.

Create `drizzle/0076_indexnow_key.sql`:
```sql
ALTER TABLE `projects` ADD `indexnow_key` text;
```

Create `drizzle-pg/0054_indexnow_key.sql`:
```sql
ALTER TABLE "projects" ADD COLUMN "indexnow_key" text;
```

In `src/server/features/projects/repositories/ProjectRepository.ts`:
Add helper methods `getIndexNowKey(projectId: string)` and `setIndexNowKey(projectId: string, key: string)`.

- [ ] **Step 2: Create schemas and write unit test for IndexNowService**

Create `src/types/schemas/indexnow.ts`:
```typescript
import { z } from "zod";

export const indexNowUrlsSchema = z
  .array(z.string().url())
  .min(1, "Provide at least one URL to submit.")
  .max(10_000, "IndexNow accepts at most 10,000 URLs per submission.");
```

Create `src/server/features/indexnow/services/IndexNowService.test.ts`:
Test submitting valid URLs, grouping by host, generating and persisting a 32-character hex key, and verifying Bing/Yandex submission dispatch.

- [ ] **Step 3: Implement IndexNowService**

Create `src/server/features/indexnow/services/IndexNowService.ts`:
- Validate URL hosts against project website domains.
- Generate or retrieve project's 32-character hex IndexNow key.
- Verify key file accessibility at `https://{host}/{key}.txt`.
- Send payload `{ host, key, urlList }` to `https://api.indexnow.org/indexnow` with Bing/Yandex/Yep fallback on rate limits.

- [ ] **Step 4: Create MCP Tool and register it**

Create `src/server/mcp/tools/submit-indexnow-urls.ts`.
In `src/server/mcp/server.ts`:
Import `submitIndexNowUrlsTool` and register it with `server.registerTool(...)`.

Create `src/serverFunctions/indexnow.ts`:
Server functions for dashboard UI to query key and trigger submissions.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cmd /c "pnpm vitest run src/server/features/indexnow/services/IndexNowService.test.ts"`
Expected: PASS.

- [ ] **Step 6: Commit changes**

```bash
git add src/db/app.schema.ts src/db/pg/app.schema.ts drizzle/0076_indexnow_key.sql drizzle-pg/0054_indexnow_key.sql src/server/features/projects/repositories/ProjectRepository.ts src/types/schemas/indexnow.ts src/server/features/indexnow/ src/server/mcp/tools/submit-indexnow-urls.ts src/server/mcp/server.ts src/serverFunctions/indexnow.ts
git commit -m "feat(indexnow): add indexnow schema, service, and submit_indexnow_urls mcp tool"
```

---

### Task 4: Google Connections MCP Tools (GSC Site & GA4 Property Binding)

**Files:**
- Modify: `src/server/features/ga4/services/Ga4Service.ts`
- Modify: `src/server/features/ga4/services/Ga4Service.test.ts`
- Create: `src/server/mcp/tools/google-connection-tools.ts`
- Create: `src/server/mcp/tools/google-connection-tools.test.ts`
- Modify: `src/server/mcp/server.ts`

**Interfaces:**
- Produces: `Ga4Service.listPropertiesForUserWithGrantStatus(userId: string)`
- Produces: MCP Tools:
  - `list_search_console_sites`
  - `set_search_console_site`
  - `list_google_analytics_properties`
  - `set_google_analytics_property`

- [ ] **Step 1: Write tests for Ga4Service.listPropertiesForUserWithGrantStatus**

In `src/server/features/ga4/services/Ga4Service.test.ts`:
Add test verifying that `listPropertiesForUserWithGrantStatus` returns accounts with their associated properties and grant validity.

- [ ] **Step 2: Implement listPropertiesForUserWithGrantStatus in Ga4Service.ts**

In `src/server/features/ga4/services/Ga4Service.ts`:
Implement `listPropertiesForUserWithGrantStatus(userId: string)` returning Google accounts connected by user and listing available GA4 properties with selection and expiration statuses.

- [ ] **Step 3: Create google-connection-tools.ts**

Create `src/server/mcp/tools/google-connection-tools.ts`:
- Define `listSearchConsoleSitesTool` (inspects user's GSC accounts and lists verified sites).
- Define `setSearchConsoleSiteTool` (binds a GSC property using `GscService.setSite`).
- Define `listGoogleAnalyticsPropertiesTool` (lists visible GA4 properties for user).
- Define `setGoogleAnalyticsPropertyTool` (binds a GA4 property using `Ga4Service.setProperty`).
All tools enforce `requireOrgPermission(context.auth, { integration: ["manage"] })` for mutations.

- [ ] **Step 4: Create unit tests for google-connection-tools.test.ts**

Create `src/server/mcp/tools/google-connection-tools.test.ts`:
Test that:
- `list_search_console_sites` lists accounts and marks project's bound site.
- `set_search_console_site` updates the binding and fires audit/onboarding events.
- `list_google_analytics_properties` lists accounts with `isSelected` on current property.
- `set_google_analytics_property` saves binding.

- [ ] **Step 5: Register tools in src/server/mcp/server.ts**

In `src/server/mcp/server.ts`:
Import `listSearchConsoleSitesTool`, `setSearchConsoleSiteTool`, `listGoogleAnalyticsPropertiesTool`, `setGoogleAnalyticsPropertyTool` and register each one with `server.registerTool(...)`.

- [ ] **Step 6: Run tests and typecheck**

Run: `cmd /c "pnpm vitest run src/server/mcp/tools/google-connection-tools.test.ts"`
Run: `cmd /c "pnpm exec tsc --noEmit"`
Expected: All tests pass and TypeScript compiles cleanly.

- [ ] **Step 7: Commit changes**

```bash
git add src/server/features/ga4/services/Ga4Service.ts src/server/features/ga4/services/Ga4Service.test.ts src/server/mcp/tools/google-connection-tools.ts src/server/mcp/tools/google-connection-tools.test.ts src/server/mcp/server.ts
git commit -m "feat(mcp): add tools to list and set google search console and ga4 properties"
```

---

### Task 5: Full Verification & Integration Check

**Files:**
- All touched files.

- [ ] **Step 1: Run comprehensive tests**

Run: `cmd /c "pnpm vitest run src/server/lib/audit/ src/server/features/indexnow/ src/server/mcp/tools/google-connection-tools.test.ts"`
Expected: All tests pass.

- [ ] **Step 2: Run CI checks**

Run: `cmd /c "pnpm exec tsc --noEmit"`
Expected: Zero type errors.

- [ ] **Step 3: Verify git status is clean**

Run: `cmd /c "git status -s"`
Expected: Clean working directory on branch.
