#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
run_directory=$(mktemp -d)
container="openseo-seranking-acceptance-$$"
port="${SERANKING_E2E_PORT:-3197}"
output="${SERANKING_E2E_OUTPUT:-$PWD/test-results/seranking-docker}"

cleanup() {
  docker stop --timeout 3 "$container" >/dev/null 2>&1 || true
  rm -rf "$run_directory"
}
trap cleanup EXIT

mkdir -p "$run_directory/source" "$output"
git ls-files -z --cached --others --exclude-standard -- src drizzle e2e/fixtures \
  package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json vite.config.ts \
  vite-plugin-lean-worker-bundle.ts wrangler.jsonc worker-configuration.d.ts |
  tar --null -T - -cf - | tar -C "$run_directory/source" -xf -

docker run --rm --init -d --name "$container" --publish "127.0.0.1:$port:$port" --dns 127.0.0.1 \
  --mount "type=bind,src=$run_directory/source,dst=/source,readonly" \
  -e AUTH_MODE=local_noauth -e "PORT=$port" -e VITE_SHOW_DEVTOOLS=false \
  -e WRANGLER_SEND_METRICS=false -e CLOUDFLARE_CF_FETCH_ENABLED=false \
  -e CLOUDFLARE_INCLUDE_PROCESS_ENV=true -e SERANKING_ENABLED=true \
  -e SERANKING_API_KEY=openseo-mocked-project-key -e SERANKING_BASE_URL=http://127.0.0.1:3198 \
  --entrypoint sh "${OPENSEO_DEV_IMAGE:-open-seo-dev:local}" -c '
    set -eu
    cp -R /source/. /app/
    pnpm exec wrangler d1 migrations apply DB --local > /tmp/migrations.log 2>&1
    pnpm exec wrangler d1 execute DB --local --file e2e/fixtures/seranking-selective-sync/seed.sql > /tmp/seed.log 2>&1
    node e2e/fixtures/seranking-selective-sync/provider.mjs &
    exec pnpm exec vite dev --mode sync-acceptance --host 0.0.0.0 --port "$PORT" --strictPort
  ' >/dev/null

export PLAYWRIGHT_BASE_URL="http://127.0.0.1:$port"
export PLAYWRIGHT_SERANKING_MOCK=1
ready=false
for ((attempt = 0; attempt < 120; attempt++)); do
  if curl --silent --fail --max-time 2 "$PLAYWRIGHT_BASE_URL/" >/dev/null; then
    ready=true
    break
  fi
  sleep 1
done
if [[ "$ready" == false ]]; then
  docker logs --tail 50 "$container" >&2
  exit 1
fi

sql_history='SELECT * FROM rank_snapshots ORDER BY id'
docker exec "$container" pnpm exec wrangler d1 execute DB --local --json --command "$sql_history" > "$output/history-before.json"
pnpm test:e2e e2e/seranking-selective-sync.spec.ts --grep 'preview reads' --output "$output/preview"
docker exec "$container" node -e '
  const assert = require("node:assert/strict");
  const calls = require("node:fs").readFileSync("/tmp/mock-provider.jsonl", "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(calls.length > 0);
  assert.ok(calls.every(call => call.method === "GET"));
  console.log("Preview issued", calls.length, "reads and zero writes");
'
pnpm test:e2e e2e/seranking-selective-sync.spec.ts --grep 'confirmed sync' --output "$output/confirm"
docker exec "$container" cat /tmp/mock-provider.jsonl > "$output/provider.jsonl"
docker exec "$container" pnpm exec wrangler d1 execute DB --local --json --command "$sql_history" > "$output/history-after.json"
docker exec "$container" pnpm exec wrangler d1 execute DB --local --json --command \
  'SELECT tracking_keyword_id,remote_keyword_id,status FROM se_ranking_keyword_mappings ORDER BY tracking_keyword_id' > "$output/mappings.json"

node --input-type=module - "$output" <<'JS'
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const read = name => readFileSync(join(dir, name), "utf8");
const results = name => JSON.parse(read(name)).flatMap(entry => entry.results);
const calls = read("provider.jsonl").trim().split("\n").map(JSON.parse);
const allowedReads = new Set(["/users/me", "/sites", "/sites/search-engines", "/keywords"]);
assert.ok(calls.filter(call => call.method === "GET").every(call => allowedReads.has(call.path)));
const writes = calls.filter(call => call.method !== "GET");
const post = writes.find(call => call.method === "POST");
const patch = writes.find(call => call.method === "PATCH");
assert.equal(writes.length, 2);
assert.equal(post.path, "/keywords");
assert.deepEqual(post.body, [{ keyword: "أرضيات ملاعب بادل", site_engine_ids: [539194, 545914] }]);
assert.equal(patch.path, "/keywords");
assert.equal(patch.query.keyword_id, "9001");
assert.equal(patch.body.target_url, "https://matchday.example/football");
assert.deepEqual(patch.body.site_engine_ids, [539194, 545914, 999888]);
assert.deepEqual(results("history-before.json"), results("history-after.json"));
const mappings = results("mappings.json");
assert.equal(mappings.length, 3);
assert.ok(mappings.every(row => row.status === "synced"));
assert.ok(mappings.some(row => row.remote_keyword_id === "9001"));
assert.ok(mappings.some(row => row.remote_keyword_id === "9100"));
console.log("Verified both engines, preserved the unrelated engine and target URL, and kept all rank history and paid endpoints untouched.");
JS
