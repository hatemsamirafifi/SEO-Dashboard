import type { Fixture } from "./types";
import { htmlResponse, renderPage } from "../lib";
import { article } from "./helpers";

const CAT = "HTTP status & links";

// 18 — a URL that returns 404 (discovered via sitemap) --------------------
const notFound: Fixture = {
  path: "/status/not-found",
  category: CAT,
  name: "Page returns 404",
  summary: "Listed in the sitemap, but responds 404 Not Found.",
  lesson:
    "A dead URL in your sitemap wastes crawl budget on every visit. Remove it, restore the page, or redirect it to a real one.",
  expectedIssues: ["broken-page"],
  // The sitemap lists it, so a crawler finds a dead URL. Kept off the catalog
  // so the catalog itself does not earn a broken-internal-link.
  linkedFromCatalog: false,
  inSitemap: true,
  handler: () =>
    htmlResponse(
      renderPage({
        fixture: notFound,
        title: "404, this page does not exist",
        metaDescription: "A URL that is listed in the sitemap but returns 404.",
        bodyHtml: article({
          h1: "404, but the sitemap still lists it",
          lede: "The sitemap says this page exists. The server returns 404.",
          sections: [
            {
              h2: "Why a 404 in the sitemap is a problem",
              body: "A sitemap is a list of pages you are telling search engines to go crawl. When one of those URLs returns 404, you spend crawl budget fetching nothing and keep pointing the crawler at a page that is not there. On a large site, thousands of these add up.",
            },
            {
              h2: "The fix",
              body: "If the page should exist, restore it. If it is gone for good, take it out of the sitemap and out of any internal links, and if something replaced it, add a 301 to that page. What you do not want is to leave it in the sitemap, telling crawlers to keep visiting a URL that no longer works.",
            },
          ],
        }),
      }),
      { status: 404 },
    ),
};

// 19 — a URL that returns 500 --------------------------------------------
const serverError: Fixture = {
  path: "/status/server-error",
  category: CAT,
  name: "Server error (500)",
  summary: "Responds 500 Internal Server Error instead of a page.",
  lesson:
    "Repeated 5xx errors make search engines crawl a site less and can drop pages from the index. A missing page should return 404, not 500.",
  expectedIssues: ["server-error"],
  linkedFromCatalog: false,
  inSitemap: true,
  handler: () =>
    htmlResponse(
      renderPage({
        fixture: serverError,
        title: "500, the server errored",
        metaDescription: "A URL that returns a 500 error to every crawler.",
        bodyHtml: article({
          h1: "500, a server error",
          lede: "This URL does not return 404. It returns a 500 every time.",
          sections: [
            {
              h2: "5xx is worse than 4xx",
              body: "A 404 says the page is not here. A 500 says the server itself failed while trying to answer. Search engines treat repeated 5xx errors as a sign the site is unhealthy and respond by slowing their crawl. Do it often enough and pages start dropping out of the index.",
            },
            {
              h2: "Return the right code",
              body: "If content is gone, return a 404 or 410 so the search engine can update its records. Keep 500s for actual, unexpected failures, and then read the logs and fix them. A route that returns 500 every time is not an error page, it is a bug.",
            },
          ],
        }),
      }),
      { status: 500 },
    ),
};

// 20 — bot challenge / access denied (403) --------------------------------
const blocked: Fixture = {
  path: "/status/blocked",
  category: CAT,
  name: "Crawler blocked (403)",
  summary: 'Returns 403 Forbidden. The honest "we could not read this" case.',
  lesson:
    "A 403, a 429, or a bot challenge means the crawler was blocked. A good audit says so, instead of reporting the page as broken. Real search bots may hit the same wall.",
  expectedIssues: ["blocked-page"],
  linkedFromCatalog: false,
  inSitemap: true,
  handler: () =>
    htmlResponse(
      renderPage({
        fixture: blocked,
        title: "403, the crawler was blocked",
        metaDescription: "A page that returns 403 Forbidden to crawlers.",
        bodyHtml: article({
          h1: "403, access denied to the crawler",
          lede: "Aggressive bot protection can block the good crawlers along with the bad ones.",
          sections: [
            {
              h2: "Blocked is not the same as broken",
              body: "When a page answers a crawler with 403, 429, or a challenge screen, the honest conclusion is not that the page is broken. It is that the crawler was not allowed to see it. A good audit says exactly that. Reporting a blocked page as a content problem would send you looking for a bug that is not there, when the real issue is access.",
            },
            {
              h2: "When your own protection backfires",
              body: "Strict WAF rules and bot-fight modes often catch real crawlers in the same net as scrapers. If search engines or your own audit keep getting blocked, allowlist their user agents so they can read the site. A page nobody can crawl is a page that cannot rank, however good the content behind the wall is.",
            },
          ],
        }),
      }),
      { status: 403 },
    ),
};

// 21 — a healthy page that links to the 404 above -------------------------
const brokenInternalLink: Fixture = {
  path: "/links/broken-internal-link",
  category: CAT,
  name: "Broken internal link",
  summary: "Links to /status/not-found, which returns 404.",
  lesson:
    "Linking to your own dead URLs frustrates people, wastes crawl budget, and sends link strength nowhere. Fix or remove the link.",
  expectedIssues: ["broken-internal-link"],
  handler: () =>
    htmlResponse(
      renderPage({
        fixture: brokenInternalLink,
        title: "A page with a broken internal link",
        metaDescription:
          "This page is otherwise fine, but it links to one of its own URLs that returns a 404.",
        bodyHtml: `<h1>The link below goes nowhere</h1>
<p class="lede">This page is fine, except that it links to a page that no longer exists.</p>
<p>Broken internal links are one of the most common and most avoidable technical SEO problems. A person clicks, hits a 404, and leaves. A crawler follows the link, wastes a request, and learns nothing. Any link strength that should have gone to a real page goes into a dead end instead. Unlike a broken external link, this one is entirely yours to fix.</p>
<p>Here is the link, pointing at a URL on this site that returns a 404: <a href="/status/not-found">read our full guide</a>. Click it and you land on a Not Found page, which is what the audit reports when it crawls this link and sees the target return 404.</p>
<h2>How to catch these</h2>
<p>Crawl your own site regularly and check the status of every internal link target. The moment a linked page starts returning 4xx or 5xx, repoint the link to the correct URL or remove it. Do not rely on a redirect to cover it forever; link straight to the page that works.</p>`,
      }),
    ),
};

// 22 — rate limited (429 + Retry-After) -----------------------------------
const rateLimited: Fixture = {
  path: "/status/rate-limited",
  category: CAT,
  name: "Rate limited (429)",
  summary:
    "Answers 429 with a Retry-After header. The audit must slow down and say so.",
  lesson:
    "A 429 is a speed limit, not a broken page. A good audit honors Retry-After, paces itself, retries the URL, and finally reports which pages it never managed to read.",
  expectedIssues: ["rate-limited-page"],
  linkedFromCatalog: false,
  inSitemap: true,
  handler: () =>
    htmlResponse(
      renderPage({
        fixture: rateLimited,
        title: "429, too many requests",
        metaDescription:
          "A URL that answers with 429 and a Retry-After header.",
        bodyHtml: article({
          h1: "429, slow down",
          lede: "This URL answers a crawler with 429 Too Many Requests.",
          sections: [
            {
              h2: "Why 429 shows up",
              body: "Rate limiting means the site is telling the crawler its traffic is too aggressive. It usually arrives with a Retry-After header. A good audit waits out that header and tries again instead of either hammering the site or dropping the page silently.",
            },
            {
              h2: "What a good audit reports",
              body: "The honest outcome is not a missing title or thin content, because the audit never saw the content. The honest outcome is a record that this page was rate limited, along with the pages the audit had to give up on.",
            },
          ],
        }),
      }),
      { status: 429, headers: { "retry-after": "5" } },
    ),
};

// 23 — a served-with-200 bot challenge (no real status code gives it away) --
const challengeActioned200: Fixture = {
  path: "/status/challenge-200",
  category: CAT,
  name: "Challenge page with a 200 status",
  summary:
    'Returns 200 OK with a "Just a moment..." interstitial — WAF challenges can hide in a healthy status code.',
  lesson:
    "Heavy bot-mitigation suites serve challenge pages with a 200 status. An audit that only checks status codes records the challenge HTML as if it were the site, and reports page-optimization issues that are not real.",
  expectedIssues: ["blocked-page"],
  linkedFromCatalog: false,
  inSitemap: true,
  handler: () =>
    htmlResponse(
      renderPage({
        fixture: challengeActioned200,
        title: "Just a moment...",
        metaDescription: "A challenge page served with a healthy 200 status.",
        bodyHtml: article({
          h1: "Just a moment...",
          lede: "This page passes the status check while serving a challenge.",
          sections: [
            {
              h2: "Status codes are not content checks",
              body: "Some WAF product configurations return the challenge interstitial with a 200 status, because the challenge activates with JavaScript. A crawler that trusts the 200 sees a strange page and reports phantom issues like a missing heading or thin content.",
            },
            {
              h2: "The fix",
              body: "The audit should recognize the challenge HTML, mark the page as blocked, and ask you to allowlist the crawler instead of flagging content issues that are not there.",
            },
          ],
        }),
      }),
    ),
};

// 24 — a client-side rendered shell ---------------------------------------
const csrShell: Fixture = {
  path: "/status/csr-shell",
  category: CAT,
  name: "Client-side rendered shell",
  summary:
    "Serves an empty render root plus an app bootstrap: content exists only in JavaScript.",
  lesson:
    "When a page ships an empty shell, the audit cannot read real content, so it must not invent SEO verdicts. The page is marked extraction-uncertain and stays free of confirmed missing-* findings.",
  expectedIssues: [],
  linkedFromCatalog: false,
  inSitemap: true,
  handler: () =>
    htmlResponse(
      renderPage({
        fixture: csrShell,
        title: "Rendered in the browser only",
        metaDescription:
          "An app shell whose marketing content is injected by JavaScript only, so the audit defers content verdicts.",
        showPanel: false,
        bodyHtml: '<div id="root"></div><script src="/app.js"></script>',
      }),
    ),
};

export const httpStatusFixtures: Fixture[] = [
  notFound,
  serverError,
  blocked,
  brokenInternalLink,
  rateLimited,
  challengeActioned200,
  csrShell,
];
