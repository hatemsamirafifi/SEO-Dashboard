# OpenSEO

<p align="center">
  <strong>The open-source alternative to Semrush and Ahrefs built for humans and AI agents.</strong>
</p>

<p align="center">
  <a href="https://github.com/every-app/open-seo/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License" /></a>
  <a href="https://github.com/every-app/open-seo/releases"><img src="https://img.shields.io/badge/version-0.1.3-green.svg" alt="Version" /></a>
  <a href="https://openseo.so"><img src="https://img.shields.io/badge/hosted-openseo.so-blueviolet.svg" alt="Hosted App" /></a>
  <a href="https://discord.gg/c9uGs3cFXr"><img src="https://img.shields.io/badge/discord-join_chat-7289da.svg" alt="Discord" /></a>
  <a href="https://x.com/bensenescu"><img src="https://img.shields.io/badge/follow-%40bensenescu-black.svg?logo=x" alt="Twitter/X" /></a>
</p>

---

OpenSEO is a fast, modern, and transparent SEO platform. If legacy suites like Semrush or Ahrefs feel bloated, restrictive, or prohibitively expensive, OpenSEO offers a pay-as-you-go alternative where **you own your data and control your costs**.

OpenSEO is designed from the ground up for both human operators and autonomous AI agents: connect external agents like **Claude Code**, **OpenClaw**, **Hermes**, or **Cursor** via our native Model Context Protocol (MCP) server, or collaborate directly with **SAM**, our built-in SEO agent.

<p align="center">
  <img width="1385" height="794" alt="OpenSEO Dashboard Preview" src="https://github.com/user-attachments/assets/fd208249-44ea-4849-bb4b-5fc896aeab73" />
</p>

---

## ⚡ Highlights

- 💸 **Pay-As-You-Go**: No expensive tiered subscriptions required to self-host. Bring your own DataForSEO API key and pay only pennies for what you use.
- 🛡️ **Free-First Data Architecture**: Aggressive R2 caching, free first-party integrations (Google Search Console, Google Ads, Bing Webmaster), and internal database snapshots drastically minimize paid API calls.
- 🤖 **In-App AI Agent (SAM)**: Stateful SEO agent running in Cloudflare Durable Objects via `@cloudflare/think` with persistent project memory, bounded loops, and streaming defense.
- 🔌 **Native MCP Server & Agent Skills**: Expose your SEO tools directly to AI coding agents via standard Model Context Protocol and 15+ pre-built SEO workflow skills.
- 📈 **Rank Tracking & Trend Analytics**: Daily, weekly, or manual rank snapshots with movement deltas (`+2`, `-5`, previous position) and historical trend modals across 7d, 30d, 90d, and all-time timeframes.
- 🕷️ **Free Technical Site Audits**: Built-in local crawler evaluates title tags, meta descriptions, canonical URLs, headings, links, JSON-LD, and hreflang without consuming paid third-party API credits.
- 🔐 **Zero Trust & Scoped Credentials**: AES-GCM encrypted credentials with strict domain separation (`:ai-credentials-v1`), UI masking, and scoped resolution (`Project → Organization → Environment`).
- 🩺 **Real-Time API Health & Diagnostics**: Instant DataForSEO health check cards, latency monitoring, balance tracking, and in-browser global debug trace.
- 📦 **Dual SQLite & Postgres Compatibility**: Run lightweight SQLite/D1 for self-hosting and local dev, or scale to Postgres for enterprise workloads using Drizzle ORM.

---

## 🚀 Quickstart

### Option 1: Docker (Fastest Self-Host)

Run a complete OpenSEO instance locally in seconds with Docker Compose:

```bash
# Clone the repository
git clone https://github.com/every-app/open-seo.git
cd open-seo

# Copy example environment variables
cp .env.example .env

# Add your DataForSEO credentials to .env (see docs/DATAFORSEO_API_KEY.md)
# Then launch the container:
docker compose up -d
```

Open [http://localhost:3001](http://localhost:3001) in your browser.

> For development with live reload inside Docker, use `docker compose -f compose.dev.yaml up --build`. See [`docs/local-docker-development.md`](./docs/local-docker-development.md).

---

### Option 2: Local Node & pnpm Setup

```bash
# 1. Ensure Node.js 20+ is installed, then activate pnpm
corepack enable
pnpm install --frozen-lockfile

# 2. Set up local configuration
cp .env.example .env.local

# 3. Add your DataForSEO API key (base64 encoded login:password)
# printf '%s' 'YOUR_LOGIN:YOUR_PASSWORD' | base64
# Set AUTH_MODE=local_noauth in .env.local for local development

# 4. Apply local D1 SQLite database migrations
pnpm run db:migrate:local

# 5. Start the development server
pnpm run dev
```

For agent-friendly logging through [portless](https://github.com/vercel-labs/portless):

```bash
pnpm dev:agents
```

This serves OpenSEO at `http://open-seo.localhost:1355` and pipes structured logs to `.logs/dev-server.log`.

---

## 🧭 Core Capabilities

### 1. Keyword Research & SERP Exploration

- Discover high-impact keyword opportunities with search volume, keyword difficulty, CPC, competition score, and search intent classification.
- Live SERP inspection and competitor ranking breakdown.
- Organize, tag, and export keywords with custom color palettes and persistent metrics.

### 2. Rank Tracking & Historical Trend Analysis

- Configure automated rank checks across mobile and desktop devices.
- Multi-timeframe trend visualization: inspect ranking trajectories across **7 days**, **30 days**, **90 days**, or **All Time**.
- Instant position movement metrics (`previousPosition`, delta changes, best position).
- Duplicate-run prevention and non-blocking background queue execution.

### 3. In-App AI Agent (SAM)

- Runs within a stateful Cloudflare Durable Object using `@cloudflare/think`.
- **Multi-Provider LLM Support**:
  - **OpenRouter** (supports Zero Data Retention / ZDR models)
  - **OpenAI** (`gpt-5`, `gpt-4o`, etc.)
  - **Google Gemini** (`gemini-2.5-flash`, `gemini-1.5-pro`)
  - **Anthropic** (`claude-sonnet-4-5`, `claude-3-5-sonnet`)
  - **Ollama Cloud** & **OpenAI-Compatible** self-hosted endpoints (vLLM, LM Studio, Ollama)
- Scoped credential hierarchy: overrides cascade seamlessly (`Project Settings → Organization Settings → Environment Variables → Defaults`).
- Persistent project memory context (`sam_project_memory`) shared across chat sessions.

### 4. Search Performance (Google Search Console & Bing)

- Free first-party organic performance data: clicks, impressions, CTR, and average position.
- Persistent database sync service (`GscSyncService`) with scheduled updates and background ingestion.
- Deep slicing across queries, target pages, countries, and device types.

### 5. Free Local Site Audits

- Integrated local crawler analyzes page technical health:
  - Title and meta description length/presence
  - Canonical URLs and robot indexing directives
  - H1-H6 heading hierarchy
  - Internal and external link health
  - JSON-LD structured data extraction and hreflang validation
- Zero third-party API consumption; completely free to run. Optional Lighthouse integration for PageSpeed and Core Web Vitals.

### 6. Backlink Analysis & Competitor Intelligence

- Comprehensive backlink profile summaries, referring domain authority, and anchor text distribution.
- New and lost backlink discovery over time.
- Competitor domain organic footprint and keyword overlap analysis.
- Cost-profiling utilities (`pnpm billing:backlinks`, `pnpm billing:brand-lookup`) to safeguard API spend.

### 7. Provider Health & Diagnostics

- Real-time DataForSEO API health status card in Settings.
- Diagnostic connection tester and live balance verification.
- In-browser **Global Trace Store** tracking all client, server, and MCP tool operations with status filters and error diagnostics.

---

## 🏛️ Free-First Data Architecture

OpenSEO employs a **cache-first, free-first** routing strategy to guarantee that paid third-party APIs are treated strictly as an absolute fallback:

```
┌─────────────────┐
│ Inbound Request │
└────────┬────────┘
         ▼
┌─────────────────┐      Hit
│    R2 Cache     ├──────────────► [ Return Cached Data (24h - 14d TTL) ]
└────────┬────────┘
         │ Miss
         ▼
┌─────────────────┐     Available
│  Free Providers ├──────────────► [ GSC / Google Ads / Bing / Local Crawler ]
└────────┬────────┘
         │ Not Available
         ▼
┌─────────────────┐     Available
│   Internal DB   ├──────────────► [ Historical D1 / Postgres Snapshots ]
└────────┬────────┘
         │ Missing / Expired
         ▼
┌─────────────────┐
│ Paid DataForSEO │──────────────► [ Metered Fallback with Budget Guardrails ]
└─────────────────┘
```

- **Budget Guards**: Enforce hard limits with `DATAFORSEO_DAILY_BUDGET` and `DATAFORSEO_MONTHLY_BUDGET`.
- **Request Coalescing**: Automatically deduplicates concurrent identical outbound queries.
- **SSRF Hardening**: Protects local crawler requests from probing private, internal, or loopback network ranges.
- **Offline/Free Mode**: OpenSEO remains fully functional with `DATAFORSEO_ENABLED=false` for any workflow backed by free or internal data sources.

---

## 🤖 MCP Server & Agent Skills

OpenSEO natively exposes a [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server so external coding assistants and AI agents can execute SEO tasks directly.

### Connecting External Agents

Add OpenSEO to your Claude Desktop, Claude Code, Cursor, or OpenClaw configuration:

```json
{
  "mcpServers": {
    "openseo": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-everything"],
      "env": {
        "OPENSEO_API_URL": "http://localhost:3001"
      }
    }
  }
}
```

### Pre-Built Agent Skills

OpenSEO includes 15+ specialized agent skills in `.agents/skills/`:

- `keyword-research` — Discover opportunities, evaluate metrics, and save promising keywords.
- `seo-audit` — Run comprehensive technical audits and generate actionable fixes.
- `competitor-analysis` — Dissect competitor organic visibility and keyword footprints.
- `keyword-clustering` — Cluster keywords by search intent and topical hubs.
- `link-prospecting` — Discover high-quality backlink prospects from SERPs.
- `local-seo` — Audit Google Business Profiles and local map pack rankings.
- `seo-coach` — Guided, conversational SEO assistant explaining workflows and recommendations.

---

## 🛠️ Tech Stack

| Component              | Technology                                                                                         | Description                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **Framework**          | [TanStack Start](https://tanstack.com/start)                                                       | React 19, TanStack Router, TanStack Query, React Form, React Table                |
| **Runtime**            | [Cloudflare Workers](https://workers.cloudflare.com/)                                              | Edge-native serverless runtime via workerd and `@cloudflare/vite-plugin`          |
| **Agent Engine**       | [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/)                   | Stateful agent execution via `@cloudflare/think` and AI SDK                       |
| **Databases**          | [Cloudflare D1](https://developers.cloudflare.com/d1/) / [PostgreSQL](https://www.postgresql.org/) | SQLite at edge or Postgres, managed with [Drizzle ORM](https://orm.drizzle.team/) |
| **Caching & Storage**  | [Cloudflare R2](https://developers.cloudflare.com/r2/)                                             | S3-compatible low-latency object storage for cached SEO data & audits             |
| **Authentication**     | [Better Auth](https://better-auth.com/) / Cloudflare Access                                        | Cloudflare Access JWT validation or local trusted `noauth`                        |
| **Styling**            | [Tailwind CSS v4](https://tailwindcss.com/) & [DaisyUI](https://daisyui.com/)                      | Modern CSS design tokens, dark mode, responsive layout                            |
| **Type Safety & Lint** | TypeScript & [oxlint](https://oxc.rs/)                                                             | End-to-end type safety, Zod validation schemas, fast type-aware linting           |

---

## ⚙️ Configuration Reference

Key variables in `.env` / `.env.local`:

| Variable                        | Default             | Purpose                                                              |
| ------------------------------- | ------------------- | -------------------------------------------------------------------- |
| `DATAFORSEO_API_KEY`            | _(none)_            | Base64-encoded `login:password` for DataForSEO access.               |
| `AUTH_MODE`                     | `cloudflare_access` | `local_noauth` (local dev/Docker), `cloudflare_access`, or `hosted`. |
| `PORT`                          | `3001`              | Application listening port.                                          |
| `AI_AGENT_PROVIDER`             | `openrouter`        | Default AI provider (`openrouter`, `openai`, `gemini`, `anthropic`). |
| `AI_CREDENTIALS_ENCRYPTION_KEY` | _(falls back)_      | 32+ char secret for AES-GCM encryption of in-app credentials.        |
| `OPENROUTER_API_KEY`            | _(optional)_        | API key for OpenRouter models.                                       |
| `OPENAI_API_KEY`                | _(optional)_        | API key for OpenAI models.                                           |
| `GEMINI_API_KEY`                | _(optional)_        | API key for Google Gemini models.                                    |
| `ANTHROPIC_API_KEY`             | _(optional)_        | API key for Anthropic Claude models.                                 |
| `DATAFORSEO_DAILY_BUDGET`       | _(none)_            | Daily spending guard in USD.                                         |
| `DATAFORSEO_MONTHLY_BUDGET`     | _(none)_            | Monthly spending guard in USD.                                       |
| `GOOGLE_CLIENT_ID`              | _(optional)_        | Google OAuth Client ID for Search Console integration.               |
| `GOOGLE_CLIENT_SECRET`          | _(optional)_        | Google OAuth Client Secret for Search Console.                       |

See [`.env.example`](./.env.example) for the exhaustive list of options.

---

## 💻 CLI & Development Scripts

```bash
# Development
pnpm run dev                 # Start local Vite development server
pnpm run dev:agents          # Start dev server with portless and agent log capture
pnpm run dev:docker          # Spin up containerized local development environment

# Database & Migrations
pnpm run db:generate         # Generate migrations for both D1 (SQLite) and Postgres
pnpm run db:migrate:local    # Apply pending migrations to local SQLite/D1 database
pnpm run db:migrate:pg       # Apply pending migrations to PostgreSQL database

# Quality & Testing
pnpm run ci:check            # Full CI suite: prettier, knip, typecheck, and oxlint
pnpm run test                # Run unit and integration tests with Vitest
pnpm run test:e2e            # Run browser end-to-end tests with Playwright
pnpm run lint                # Run oxlint type-aware linter

# Seeding & Utilities
pnpm run seed:projects       # Seed demo projects for development
pnpm run seed:rank-tracking  # Seed sample rank tracking keywords and snapshot runs
pnpm run billing:usage       # Audit current DataForSEO account usage and balance
```

---

## 🚢 Deployment Options

- **Docker**: Simple single-node self-hosting for individuals and small teams. See [`docs/SELF_HOSTING_DOCKER.md`](./docs/SELF_HOSTING_DOCKER.md).
- **Cloudflare Workers**: Serverless, multi-region production deployment backed by Cloudflare D1, R2, KV, and Durable Objects. See [`docs/SELF_HOSTING_CLOUDFLARE.md`](./docs/SELF_HOSTING_CLOUDFLARE.md).
- **Hosted Cloud**: Don't want to self-host? Use the managed platform at [openseo.so](https://openseo.so).

---

## 🤝 Contributing

Contributions are warmly welcomed! Please read our [Contributing Guide](docs/CONTRIBUTING.md) and [Maintainers Guide](docs/MAINTAINERS.md) before submitting pull requests.

To run the complete check suite locally:

```bash
pnpm run ci:check
```

---

## 💬 Community

- **Discord**: [Join our Discord community](https://discord.gg/c9uGs3cFXr) to chat, ask questions, and share workflows.
- **X / Twitter**: Follow [@bensenescu](https://x.com/bensenescu) for release announcements and progress updates.
- **Website**: [openseo.so](https://openseo.so)

---

## 📄 License

OpenSEO is open-source software licensed under the [MIT License](LICENSE).
