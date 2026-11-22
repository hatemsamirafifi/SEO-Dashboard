import process from "node:process";

const liveDataforseo = process.env.RUN_LIVE_DATAFORSEO_TESTS === "true";
if (!liveDataforseo) Reflect.deleteProperty(process.env, "DATAFORSEO_API_KEY");
for (const key of Object.keys(process.env)) {
  if (/^(?:SERANKING_|SE_RANKING_|GOOGLE_ADS_)/u.test(key)) {
    delete process.env[key];
  }
}

// Mocked transports can replace fetch in individual tests. A real provider
// transport must pass this check before calling Node's HTTP implementation.
const fetchFromNetwork = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  const domain = url.hostname.toLowerCase();
  const blocked =
    ((domain === "dataforseo.com" || domain.endsWith(".dataforseo.com")) &&
      !liveDataforseo) ||
    domain === "googleads.googleapis.com" ||
    domain === "seranking.com" ||
    domain.endsWith(".seranking.com") ||
    domain === "seranking.ru" ||
    domain.endsWith(".seranking.ru");
  if (blocked) {
    return Promise.reject(
      new Error(`Live provider network is disabled in Vitest (${domain}).`),
    );
  }
  return fetchFromNetwork(input, init);
};
