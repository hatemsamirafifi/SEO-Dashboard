import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
import { z } from "zod";

const keywordPayload = z.object({
  keyword: z.string().min(1),
  site_engine_ids: z.array(z.number().int().positive()).min(1),
  target_url: z.string().optional(),
});
const keywordBatch = z.array(keywordPayload).min(1);

const siteId = 13188608;
const desktop = 539194;
const mobile = 545914;
const unrelated = 999888;
const keywords = [
  {
    id: "9001",
    name: "إنشاء ملاعب كرة القدم".normalize("NFD"),
    group_id: "7",
    link: "https://matchday.example/football",
    site_engine_ids: [desktop, unrelated],
  },
  {
    id: "9002",
    name: "صيانة الملاعب الرياضية",
    group_id: "8",
    link: null,
    site_engine_ids: [desktop, mobile],
  },
];
const engines = [
  {
    site_engine_id: desktop,
    search_engine_id: 610,
    name: "Google Egypt",
    lang_code: "ar",
    device: "desktop",
  },
  {
    site_engine_id: mobile,
    search_engine_id: 611,
    name: "Google Egypt Mobile",
    lang_code: "ar",
    device: "mobile",
  },
  {
    site_engine_id: unrelated,
    search_engine_id: 612,
    name: "Bing Egypt",
    lang_code: "ar",
    device: "desktop",
  },
];
/** @param {string} keyword */
const identity = (keyword) => keyword.trim().normalize("NFC").toLowerCase();
let nextKeywordId = 9100;

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname.replace("/v1/project-management", "");
  const reply = (value, status = 200) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(value));
  };
  const payload = [];
  for await (const chunk of req) payload.push(chunk);
  /** @type {unknown} */
  const body = payload.length
    ? JSON.parse(Buffer.concat(payload).toString())
    : undefined;
  appendFileSync(
    "/tmp/mock-provider.jsonl",
    JSON.stringify({
      method: req.method,
      path,
      query: Object.fromEntries(url.searchParams),
      body,
    }) + "\n",
  );

  if (req.headers.authorization !== "Token openseo-mocked-project-key")
    return reply({ message: "Unknown fixture credentials" }, 401);
  if (req.method === "GET" && path === "/users/me")
    return reply({ keywords_limit: 1000, projects_limit: 10 });
  if (
    req.method === "GET" &&
    (path === "/sites" || path === "/sites/summary")
  ) {
    const site = {
      id: siteId,
      site_id: siteId,
      title: "Matchday Sports",
      url: "https://matchday.example",
      keyword_count: keywords.length,
      check_freq: "manual",
    };
    return reply(path === "/sites" ? [site] : site);
  }
  if (Number(url.searchParams.get("site_id")) !== siteId)
    return reply({ message: "Unknown fixture project" }, 404);
  if (req.method === "GET" && path === "/sites/search-engines")
    return reply(engines);
  if (req.method === "GET" && path === "/keywords") {
    const engine = Number(url.searchParams.get("site_engine_id"));
    return reply(
      engine
        ? keywords.filter((keyword) => keyword.site_engine_ids.includes(engine))
        : keywords,
    );
  }
  if (req.method === "POST" && path === "/keywords") {
    const parsed = keywordBatch.safeParse(body);
    if (!parsed.success) {
      return reply({ message: "Explicit engines required" }, 400);
    }
    const batch = parsed.data;
    if (
      batch.some((kw) =>
        keywords.some(
          (remote) => identity(remote.name) === identity(kw.keyword),
        ),
      )
    )
      return reply({ message: "Duplicate keyword" }, 409);
    const ids = batch.map((kw) => {
      const id = String(nextKeywordId++);
      keywords.push({
        id,
        name: kw.keyword,
        link: kw.target_url ?? null,
        site_engine_ids: kw.site_engine_ids,
      });
      return Number(id);
    });
    return reply({ added: ids.length, ids }, 201);
  }
  if (req.method === "PATCH" && path === "/keywords") {
    const keyword = keywords.find(
      (kw) => kw.id === url.searchParams.get("keyword_id"),
    );
    const parsed = keywordPayload.safeParse(body);
    if (!keyword || !parsed.success)
      return reply({ message: "Invalid assignment patch" }, 400);
    keyword.site_engine_ids = parsed.data.site_engine_ids;
    return reply({ added: 0, ids: [] });
  }
  return reply({ message: "Unexpected mock provider operation" }, 404);
}).listen(3198, "127.0.0.1");
