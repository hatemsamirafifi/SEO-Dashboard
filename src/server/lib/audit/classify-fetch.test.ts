import { describe, expect, it } from "vitest";
import { classifyFetch } from "@/server/lib/audit/classify-fetch";

describe("classifyFetch", () => {
  it("classifies transport failure (status 0) as error", () => {
    expect(classifyFetch(0, false, "")).toBe("error");
  });

  it("classifies a final 429 as rate_limited before any challenge check", () => {
    // A Cloudflare rate-limit rule sets cf-mitigated AND answers 429: the
    // speed limit is the honest interpretation here, not a block.
    expect(classifyFetch(429, true, "just a moment...")).toBe("rate_limited");
    expect(classifyFetch(429, false, "")).toBe("rate_limited");
  });

  it("classifies cf-mitigated responses as blocked regardless of status", () => {
    expect(classifyFetch(200, true, "<html><body>hi</body></html>")).toBe(
      "blocked",
    );
    expect(classifyFetch(403, true, "")).toBe("blocked");
    expect(classifyFetch(503, true, "Service Unavailable")).toBe("blocked");
  });

  it("classifies auth walls (401/403) as blocked without mitigation", () => {
    expect(classifyFetch(401, false, "")).toBe("blocked");
    expect(classifyFetch(403, false, "")).toBe("blocked");
  });

  it("classifies 202 Accepted as blocked — real pages are not served that way", () => {
    expect(classifyFetch(202, false, "<html></html>")).toBe("blocked");
  });

  it("recognizes 200 challenge pages served by heavy JS WAFs", () => {
    expect(
      classifyFetch(
        200,
        false,
        "<html><head><title>Just a moment...</title></head></html>",
      ),
    ).toBe("blocked");
    expect(
      classifyFetch(
        200,
        false,
        '<meta http-equiv="refresh" content="0;url=/.well-known/sgcaptcha/">',
      ),
    ).toBe("blocked");
  });

  it("recognizes 503 interstitials as challenges, not outages", () => {
    expect(classifyFetch(503, false, "Just a moment... please stand by")).toBe(
      "blocked",
    );
    expect(classifyFetch(503, false, 'class="challenge-platform"')).toBe(
      "blocked",
    );
    expect(classifyFetch(503, false, ">verifying you are human<")).toBe(
      "blocked",
    );
  });

  it("keeps an ordinary 503 outage out of the blocked bucket", () => {
    expect(classifyFetch(503, false, "Service temporarily unavailable")).toBe(
      "ok",
    );
  });

  it("classifies clean 2xx/3xx/4xx/5xx documents as ok", () => {
    expect(classifyFetch(200, false, "<html></html>")).toBe("ok");
    expect(classifyFetch(302, false, "")).toBe("ok");
    expect(classifyFetch(404, false, "Not Found")).toBe("ok");
    expect(classifyFetch(500, false, "boom")).toBe("ok");
  });
});
