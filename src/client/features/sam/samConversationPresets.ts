import {
  humanizeToolLabel,
  type ToolLabel,
} from "@/client/components/chat/ChatMessage";
import {
  isRecord,
  toolPartOutput,
  type ChatToolPart,
} from "@/client/components/chat/toolParts";

export function samToolLabel(partType: string): ToolLabel | null {
  const normalized = partType.startsWith("tool-")
    ? partType
    : `tool-${partType}`;

  if (normalized === "tool-analyze_seo_project") {
    const outcome = (part: ChatToolPart): string | null => {
      const output = toolPartOutput(part);
      if (!output || !isRecord(output)) return null;
      const recs = Array.isArray(output.recommendations)
        ? output.recommendations.length
        : 0;
      return `${recs} recommendations`;
    };
    return {
      running: "Analyzing SEO performance & opportunities",
      done: "SEO analysis complete",
      detail: outcome,
    };
  }

  if (normalized === "tool-list_seo_action_plans") {
    return {
      running: "Listing SEO action plans",
      done: "SEO action plans listed",
    };
  }

  if (normalized === "tool-get_seo_action_plan") {
    return {
      running: "Loading SEO action plan",
      done: "SEO action plan loaded",
    };
  }

  if (normalized === "tool-get_seo_action_items") {
    return {
      running: "Loading SEO action items",
      done: "SEO action items loaded",
    };
  }

  if (normalized === "tool-verify_seo_action_progress") {
    return {
      running: "Verifying SEO task progress",
      done: "SEO progress verified",
    };
  }

  if (normalized === "tool-run_site_audit") {
    return { running: "Starting site audit", done: "Site audit started" };
  }

  if (normalized === "tool-poll_site_audit") {
    const outcome = (part: ChatToolPart): string | null => {
      const output = toolPartOutput(part);
      if (!output || typeof output.state !== "string") return null;
      const progress = isRecord(output.progress) ? output.progress : undefined;
      const pages =
        progress &&
        typeof progress.current === "number" &&
        typeof progress.total === "number"
          ? `${progress.current}/${progress.total} pages`
          : null;
      switch (output.state) {
        case "completed":
          return pages ? `complete · ${pages}` : "complete";
        case "failed":
          return "failed";
        case "cancelled":
          return "cancelled";
        case "running":
          return pages ? `still running · ${pages}` : "still running";
        default:
          return null;
      }
    };
    return {
      running: "Running site audit",
      done: "Audit checked",
      detail: outcome,
    };
  }

  if (normalized === "tool-get_audit_issues") {
    return { running: "Checking issues", done: "Issues checked" };
  }
  if (normalized === "tool-get_audit_pages") {
    return { running: "Reading crawled pages", done: "Pages read" };
  }
  if (normalized === "tool-get_audit_status") {
    return { running: "Checking audit status", done: "Status checked" };
  }

  return humanizeToolLabel(normalized);
}

export const SUGGESTIONS = [
  "Analyze my website and tell me what to fix first",
  "Find quick-win keywords in striking distance",
  "Investigate recent ranking drops",
  "How is my Search Console traffic trending?",
];

export const WORKFLOW_PRESETS: { label: string; prompt: string }[] = [
  {
    label: "Prioritized SEO action plan",
    prompt:
      "Analyze my website and build a prioritized SEO action plan: tell me what to fix first, why, and how to measure success.",
  },
  {
    label: "Keyword opportunities & quick wins",
    prompt:
      "Find my highest-potential keyword opportunities, striking-distance queries, and low-CTR terms from my project data.",
  },
  {
    label: "Investigate ranking drops",
    prompt:
      "Investigate recent ranking drops across my tracked keywords and identify what declined.",
  },
  {
    label: "Full SEO opportunity analysis",
    prompt:
      "Run a full SEO opportunity analysis for this project: read the site, review Search Console performance, then research my strongest opportunities — keyword gaps, ranking quick wins, and content or technical issues worth fixing first. Summarize as a prioritized list.",
  },
  {
    label: "Commercial keyword research",
    prompt:
      "Research commercial keywords for this project: find high-intent terms people search when ready to buy, with realistic search volume and difficulty. Suggest where each should live on my site (or whether new pages are needed), and recommend which ones to save.",
  },
  {
    label: "Competitor analysis",
    prompt:
      "Identify my main SERP competitors and analyze them: what they rank for, where they win, and what content or keywords they cover that I don't. Give me a concrete gap list I can act on.",
  },
  {
    label: "Technical SEO",
    prompt:
      "Audit this site's technical SEO: run a site audit, then summarize the highest-impact issues (indexing, crawlability, Core Web Vitals, duplicate content) with a concrete fix order.",
  },
  {
    label: "Executive SEO plan",
    prompt:
      "Turn everything you know about this project into a short executive SEO plan: current standing, the 3–5 highest-leverage moves, expected impact, and a 90-day timeline. Keep it tight enough to share with a founder.",
  },
];
