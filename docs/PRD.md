# OpenSEO — Product Requirements Document (PRD)

> Open source alternative to Semrush and Ahrefs for humans and AI agents

| Field      | Value                                                                                     |
| ---------- | ----------------------------------------------------------------------------------------- |
| Product    | OpenSEO                                                                                   |
| Version    | 0.1.3                                                                                     |
| Status     | Live (hosted at [openseo.so](https://openseo.so) + self-hostable via Docker & Cloudflare) |
| Doc status | Living document — reflects the shipped product and architecture                           |
| Audience   | Maintainers, contributors, and agents working on this repo                                |

---

## 1. Overview

### 1.1 Problem

Professional SEO tools (Semrush, Ahrefs) are prohibitively expensive, locked behind aggressive subscription tiers, and overburdened with bloat. Independent operators, small agencies, and developers integrating SEO into AI-agent workflows either overpay for tools they barely utilize or lack access to reliable SEO data altogether. Furthermore, existing suites are built exclusively for human point-and-click usage, lacking native interfaces, protocols, and tooling for autonomous AI agents.

### 1.2 Solution

OpenSEO is an all-in-one, open-source SEO platform defined by four core principles:

1. **Pay-as-you-go data** — Bring your own DataForSEO API key and pay only for actual consumption. No mandatory subscription to self-host.
2. **AI-first ecosystem** — Every capability is exposed through a Model Context Protocol (MCP) server, 15+ reusable Agent Skills, and **SAM**, an in-app stateful SEO agent running in Cloudflare Durable Objects.
3. **Free-first data routing** — Aggressive multi-tier caching, free first-party integrations (Google Search Console, Google Ads, Bing Webmaster), and local crawlers minimize paid API calls.
4. **Transparent, forkable stack** — Dual SQLite/Postgres database parity with Drizzle ORM, modern React 19 / TanStack Start architecture, and rapid deployment via Docker or Cloudflare Workers.

A hosted version operates at [openseo.so](https://openseo.so) for users seeking a zero-maintenance experience, charging a modest ~28% margin on DataForSEO API requests.

### 1.3 Goals

- Provide independent site owners and agencies with Semrush/Ahrefs-grade workflows at a fraction of traditional SaaS costs.
- Deliver the reference SEO platform for AI agents (Claude Code, OpenClaw, Hermes, Cursor) via MCP and structured tool contracts.
- Maintain a cache-first, free-first data pipeline that prioritizes free/first-party data before touching paid APIs.
- Provide enterprise-grade credential security (AES-GCM encryption with domain separation) and scoped configuration hierarchies.
- Ensure 100% database compatibility across edge SQLite (Cloudflare D1) and hosted PostgreSQL.

### 1.4 Non-goals

- Building and indexing a proprietary global web crawler fleet (OpenSEO aggregates first-party and third-party data).
- Cluttered, enterprise-heavy bureaucracy and complex multi-tenant role permissions beyond Cloudflare Access / Better Auth.
- 10-year deep historical cold archives — OpenSEO stores active snapshots and queries live provider data on demand.

---

## 2. Users & Personas

| Persona                             | Description                                               | Primary Need                                                      |
| ----------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------- |
| **Indie site owner / Bootstrapper** | Manages 1–5 sites solo; strictly budget-conscious         | Affordable rank tracking, zero-cost audits, keyword discovery     |
| **SEO Consultant / Agency**         | Manages multi-client portfolios; needs clean reporting    | Project scoping, client-ready data, white-labelable self-hosting  |
| **AI Agent Power User**             | Drives SEO workflows via Claude Code, OpenClaw, or Hermes | Robust MCP server, structured JSON outputs, reusable Agent Skills |
| **Self-Hoster / Hacker**            | Desires total data ownership and zero vendor lock-in      | Single-command Docker deployment, local D1/Postgres, BYO API keys |
| **Hosted Subscriber**               | Prefers managed setup; supports open source at $10/mo     | Turnkey hosted dashboard at openseo.so                            |

---

## 3. Core Workflows (Feature Set)

### 3.1 Projects & Scoping

- All SEO data, settings, tracking configs, and AI memories are strictly scoped to a `Project` (identified by a target domain).
- Projects support default geographic locations (`location_code`) and language codes (`language_code`).
- Soft-delete support (`archived_at`) preserves historical keyword and audit data while hiding deactivated projects.
- Hierarchical configuration cascading: Project-level settings override Organization-level defaults, which in turn override Environment variables.

### 3.2 Keyword Research & SERP Exploration

- Keyword discovery powered by DataForSEO and Google Ads API: search volume, keyword difficulty, CPC, competition score, and monthly search trends.
- Automated search intent classification (informational, commercial, transactional, navigational).
- Live SERP results inspection per keyword with rich feature detection (featured snippets, local packs, knowledge graphs).
- **Saved Keywords**: Persist target terms with metadata; tag management with customizable palette colors (`saved_keyword_tags`), and MCP export support.

### 3.3 Rank Tracking & Historical Trend Analytics

- Automated and manual rank checks across desktop and mobile devices.
- Multi-cadence schedules: daily, weekly, monthly, or manual execution.
- **Position Movement Deltas**: Real-time tracking of current position, previous position (`previousPosition`), delta shift (`+2`, `-5`), and best historic rank.
- **Interactive Trend Analytics**: Multi-period historical visualizer supporting **7-day**, **30-day**, **90-day**, and **All-Time** performance charts.
- Non-blocking execution with in-flight concurrency locks (`rank_check_runs_one_active_per_config_idx`) preventing duplicate simultaneous runs.
- Fallback paths and error capture: failed keyword checks record error reasons without failing the entire run; data persists cleanly across SQLite and Postgres.

### 3.4 Competitor Insights & Domain Analysis

- Domain overview: aggregate organic traffic, keyword counts, and ranking distributions.
- Ranked keywords and keyword gap analysis (identifying terms competitors rank for).
- Relevant pages and top-performing URLs.
- SERP competitor snapshot caching (`competitor_snapshots`): repeat competitor analyses serve previous snapshots free of charge.

### 3.5 Backlink Intelligence

- Domain-level backlink summaries, referring domains, broken backlinks, and anchor text breakdowns.
- Historical backlink snapshots (`backlink_snapshots`) tracking new vs. lost backlinks and referring domains over time.
- Integrated billing and cost-profiling utilities (`billing:backlinks`, `billing:brand-lookup`) to safeguard against runaway API consumption.

### 3.6 Free Technical Site Audits

- **Built-in Local Crawler**: Comprehensive technical SEO audit executed directly by the server runtime with zero third-party API spend:
  - Title tag and meta description validation (presence, length, duplication)
  - Canonical URL verification and robots indexing directives
  - H1-H6 heading hierarchy and structure
  - Internal and external link checks with status resolution
  - JSON-LD structured data syntax and hreflang tag validation
- Per-issue drill-down and filtered issue views (`audit/issues/$resultId`).
- Optional Lighthouse integration for Core Web Vitals and PageSpeed performance diagnostics.
- Strict SSRF protection preventing crawler execution against private, internal, or loopback IPs.

### 3.7 Search Performance (Google Search Console & Bing)

- Native OAuth integration with Google Search Console for free, first-party organic performance data.
- **Persistent Ingestion Service (`GscSyncService`)**:
  - Background synchronization of clicks, impressions, CTR, and average position.
  - Dedicated storage schema (`gsc_search_performance`) preserving dimensional data across dates, queries, pages, countries, and devices.
  - Coverage testing and sync verification (`GscSyncCoverage.test.ts`).
- Rich Search Performance dashboard featuring custom date ranges, multi-metric comparison, and filter toolbars.
- Bing Webmaster integration as an additional first-party search performance provider.

### 3.8 AI Search Visibility & Brand Lookup

- Track brand and domain visibility across AI-driven search engines and conversational LLM responses.
- Brand Lookup workflow analyzing cross-aggregated mentions, top cited pages, and sentiment.
- Prompt Explorer for testing and reviewing AI answers to queries in your domain niche.

### 3.9 In-App AI Agent (SAM)

- Stateful, turn-based SEO agent running in a Cloudflare Durable Object via `@cloudflare/think`.
- Direct in-process execution of MCP tool handlers (never making recursive HTTP hops or bypassing business safeguards).
- **Multi-Provider LLM Architecture**:
  - **OpenRouter** (curated Zero Data Retention / ZDR stability matrix)
  - **OpenAI** (native `gpt-5`, `gpt-4o`)
  - **Google Gemini** (`gemini-2.5-flash`, `gemini-1.5-pro`)
  - **Anthropic Claude** (`claude-sonnet-4-5`, `claude-3-5-sonnet`)
  - **OpenAI-Compatible Endpoints** (local vLLM, LM Studio, Ollama)
  - **Ollama Cloud** endpoints
- **Zero-Trust Scoped Credentials**:
  - Encrypted at rest via AES-GCM (`better-auth` symmetric encryption) using domain-separated keying (`:ai-credentials-v1`).
  - Plaintext credentials are never returned over the network, never logged, and never exposed in the UI.
  - UI provides masked preview, connection test round-trips, and explicit Change/Remove operations.
- **Persistent Project Memory**: Cross-session memory blocks (`sam_project_memory`) storing context, goals, and research logs.
- Guardrails: Loop limits, tool deduplication, sanitized transcripts, and streaming render storm protection.

### 3.10 Model Context Protocol (MCP) Server & Agent Skills

- OAuth 2.0-protected MCP server compliant with standard Model Context Protocol specifications.
- Complete suite of specialized MCP tools (`research_keywords`, `get_serp_results`, `get_rank_tracker`, `start_site_audit`, `query_search_console_performance`, `get_backlinks_overview`, `list_projects`, etc.).
- Validated Zod input/output schemas with deterministic text formatting.
- 15+ curated Agent Skills in `.agents/skills/` empowering tools like Claude Code, OpenClaw, Cursor, and Hermes to conduct end-to-end SEO campaigns.

### 3.11 Provider Health & Budget Safeguards

- **Real-Time DataForSEO Health Diagnostics**: In-dashboard health status card checking endpoint availability, response latency, and account balance.
- **Scoped Provider Settings (`seo_provider_settings`)**: Project and Organization overrides for DataForSEO credentials, encrypted via AES-GCM.
- **Budget Guardrails**: `DATAFORSEO_DAILY_BUDGET` and `DATAFORSEO_MONTHLY_BUDGET` prevent runaway spending with structured over-budget responses.
- Request coalescing to deduplicate concurrent identical queries.

### 3.12 Observability & Global Trace

- In-browser Global Trace system (`globalTraceStore`) capturing real-time operations across client features, server actions, and MCP executions.
- Live diagnostics drawer providing status filtering (pending, running, success, error), provider breakdown, latency measurements, and payload inspection.

---

## 4. Free-First Data Architecture

OpenSEO enforces a deterministic, 4-tier data routing resolution order for all SEO queries:

```
┌─────────────────┐
│ Inbound Request │
└────────┬────────┘
         ▼
┌─────────────────┐      Hit
│ 1. R2 Cache     ├──────────────► [ Return Cached Result (TTL: 24h - 14d) ]
└────────┬────────┘
         │ Miss
         ▼
┌─────────────────┐     Available
│ 2. Free Provider├──────────────► [ Google Search Console / Ads / Bing / Local Crawler ]
└────────┬────────┘
         │ Unavailable / Not Applicable
         ▼
┌─────────────────┐     Available
│ 3. Internal DB  ├──────────────► [ Stored D1 / Postgres Snapshots & Metrics ]
└────────┬────────┘
         │ Missing / Expired
         ▼
┌─────────────────┐
│ 4. DataForSEO   ├──────────────► [ Paid Fallback (Subject to Budget Caps) ]
└─────────────────┘
```

### Routing Rules & TTL Standards

- **Keyword Research**: R2 cached for 24 hours; Google Ads used for free ideas when enabled.
- **SERP Analysis**: R2 cached for 12 hours.
- **Domain Overview & Pages**: R2 cached for 12 hours.
- **Backlink Overview**: R2 cached for 6 hours; snapshots stored permanently in internal DB.
- **AI Search Queries**: R2 cached for 7 days.
- **Offline / Zero-Paid Operation**: When `DATAFORSEO_ENABLED=false`, the application operates smoothly on free providers and internal data.

---

## 5. Platform & Deployment

### 5.1 Technology Stack

| Layer                        | Technology                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------ |
| **Application Framework**    | TanStack Start (React 19, TanStack Router, TanStack Query, React Form, React Table)  |
| **Runtime Environment**      | Cloudflare Workers (`workerd`) via `@cloudflare/vite-plugin`                         |
| **Agent Execution**          | Cloudflare Durable Objects, `@cloudflare/think`, Vercel AI SDK                       |
| **Databases**                | Cloudflare D1 (SQLite) and PostgreSQL (Hosted), unified via Drizzle ORM              |
| **Object Storage & Caching** | Cloudflare R2                                                                        |
| **Authentication**           | Cloudflare Access JWT validation, Better Auth, local trusted `noauth`                |
| **External Agent Protocol**  | `@modelcontextprotocol/sdk`, `@cloudflare/workers-oauth-provider`                    |
| **Styling & UI**             | Tailwind CSS v4, DaisyUI, Recharts, Lucide Icons, Sonner                             |
| **Validation & Security**    | Zod validation at trust boundaries, AES-GCM credential encryption                    |
| **Quality & CI**             | oxlint (type-aware), Prettier, Knip, TypeScript (`tsc --noEmit`), Vitest, Playwright |

### 5.2 Deployment Modes

1. **Docker Self-Hosting (Simple)**:
   - Standalone single-container deployment via Docker Compose (`compose.yaml`).
   - Uses `AUTH_MODE=local_noauth` for local private networks or reverse-proxy setups.
   - Live development support via `compose.dev.yaml` and `Dockerfile.dev`.
2. **Cloudflare Workers (Advanced Self-Hosting)**:
   - Edge-native serverless deployment across Cloudflare D1, R2, KV, and Durable Objects.
   - Zero-cost tier compatible; automated provisioning with Alchemy IaC (`pnpm deploy:selfhost`).
   - Secured via Cloudflare Access JWT validation (`AUTH_MODE=cloudflare_access`).
3. **Hosted Production**:
   - Managed cloud at `openseo.so` running on PostgreSQL (`AUTH_MODE=hosted`).

---

## 6. UX Principles

- **Clarity Over Bloat**: Deliver focused, purpose-built tools instead of overwhelming enterprise menus.
- **Actionable Outputs**: Surface plain-language conclusions and immediate next steps rather than raw metric dumps.
- **Uniform Experience**: In-app AI chat (SAM) operates on the identical tool contracts and datasets as external MCP agents.
- **Real-Time Transparency**: Make background data fetching, cache statuses, and provider latencies visible via Global Trace.

---

## 7. Success Metrics

| Metric                    | Target / Signal                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------ |
| **Self-Host Adoption**    | Steady growth in Docker downloads, GHCR pulls, and Cloudflare deployments.           |
| **Free-First Efficiency** | High cache hit rate (>70%) and minimal DataForSEO spend per active project.          |
| **Agent Usage**           | Frequent MCP tool calls by external coding assistants (Claude Code, Cursor, Hermes). |
| **System Reliability**    | Zero runtime crashes during crawler executions or long-running agent steps.          |
| **Hosted Conversion**     | Sustained growth of $10/month support subscriptions on openseo.so.                   |

---

## 8. Requirements Summary

### 8.1 Functional Requirements

- **FR-1**: Users can create, update, and archive domain-scoped projects with location and language preferences.
- **FR-2**: Keyword research retrieves volume, difficulty, intent, and CPC, with saved-keyword tagging and export.
- **FR-3**: Rank tracking executes scheduled or manual checks, reporting position deltas and multi-period trend visualizations (7d, 30d, 90d, all-time).
- **FR-4**: Backlinks profile and referring domain insights are viewable with strict cost-profiling guardrails.
- **FR-5**: Local crawler executes free technical SEO site audits without consuming paid API credits.
- **FR-6**: Google Search Console integration ingests, aggregates, and visualizes clicks, impressions, CTR, and position.
- **FR-7**: In-app AI agent (SAM) supports multi-provider model selection (OpenRouter, OpenAI, Gemini, Anthropic, Ollama Cloud, OpenAI-compatible).
- **FR-8**: Provider credentials (AI keys, DataForSEO credentials) are stored using AES-GCM encryption with project/org scoping and UI masking.
- **FR-9**: Data requests adhere strictly to the free-first pipeline (`Cache → Free → Internal → Paid Fallback`).
- **FR-10**: Budget guards enforce daily and monthly caps on DataForSEO API spend.
- **FR-11**: Real-time DataForSEO API health check cards verify connection, latency, and balance.
- **FR-12**: Global debug trace panel captures and surfaces client, server, and MCP operations in real time.
- **FR-13**: Complete MCP server exposes SEO workflows to external agents with validated Zod schemas.
- **FR-14**: Project activation checklist guides users through site connection, GSC linking, and MCP authorization.

### 8.2 Non-Functional Requirements

- **NFR-1**: Full schema, query, and migration compatibility across SQLite (D1) and PostgreSQL.
- **NFR-2**: AES-GCM encryption with unique domain separation (`:ai-credentials-v1`) for all stored API secrets.
- **NFR-3**: SSRF prevention blocking crawler and audit requests to internal, private, or loopback IP ranges.
- **NFR-4**: Strict end-to-end type safety validated by `tsc --noEmit`, oxlint type-aware linting, and Zod boundaries.
- **NFR-5**: Architecture adheres to TanStack Server Function → Feature Service → Repository layering.
- **NFR-6**: Normalized relational database design avoiding untyped JSON blobs for relational data.
- **NFR-7**: UI protection preventing streaming render storms and excessive re-renders during agent turns.
- **NFR-8**: Idempotent migration scripts and automated schema parity tests (`schema-parity.test.ts`).

---

## 9. Out of Scope

- Crawling the entire public web to build an in-house search index.
- Native mobile applications (iOS/Android) — responsive web application suffices.
- Complex multi-tiered enterprise access control lists beyond Cloudflare Access and Better Auth.
- Permanent archival of multi-gigabyte raw SERP HTML payloads.

---

## 10. Related Documentation

- [`README.md`](../README.md) — Main repository overview and quickstart
- [`docs/free-first-architecture-audit.md`](./free-first-architecture-audit.md) — Deep dive into cache & free provider routing
- [`docs/free-first-implementation-report.md`](./free-first-implementation-report.md) — Implementation audit and provider matrix
- [`docs/in-app-ai-agent.md`](./in-app-ai-agent.md) — In-app agent (SAM) configuration & architecture
- [`docs/openrouter-zdr-model-matrix.md`](./openrouter-zdr-model-matrix.md) — Zero Data Retention model matrix
- [`docs/ai-credentials-storage-audit.md`](./ai-credentials-storage-audit.md) — Credential encryption design
- [`docs/local-docker-development.md`](./local-docker-development.md) — Docker Compose dev environment guide
- [`docs/LOCAL_POSTGRES.md`](./LOCAL_POSTGRES.md) — Local Postgres setup and migration guide
- [`docs/SELF_HOSTING_DOCKER.md`](./SELF_HOSTING_DOCKER.md) — Production Docker self-hosting
- [`docs/SELF_HOSTING_CLOUDFLARE.md`](./SELF_HOSTING_CLOUDFLARE.md) — Production Cloudflare Workers self-hosting
- [`docs/DATAFORSEO_API_KEY.md`](./DATAFORSEO_API_KEY.md) — DataForSEO API credential setup
- [`docs/CONTRIBUTING.md`](./CONTRIBUTING.md) — Contribution guidelines and development workflow
