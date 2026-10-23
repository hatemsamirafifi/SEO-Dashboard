# P1 Baseline Manifest — recorded 2026-10-17 (pre-flight)

Authoritative record of repository state before the P1 implementation wave. Required by locked decision §1.2 of `docs/plans/2026-10-17-p1-seo-intelligence-implementation.md`.

## Branch / HEAD

- Branch: `feat/speckit-wave3-impl` (in sync with `origin/feat/speckit-wave3-impl` tracking-wise; not pushed in this wave)
- HEAD at execution start: `fb438c5c30d52ae5f52541ebab56f011c6549251` — `fix(e2e): align Playwright webServer URL to 127.0.0.1 and trim auth mode env var` (2026-10-17 23:02:18 +0300)
- Previous assessment HEAD: `809f142` (`feat(autopilot): complete SAM operations and workflow integration`)

## Working-tree status

- **Clean.** Only untracked path at start: `docs/plans/` (this manifest + the implementation plan document — created per user instruction and §1.2).
- Spec-014 note from the Phase 0 assessment (~40 dirty files at `809f142`) is **historical**: that work was committed in the interim as `5f4683e` (spec-014 completion), `b0cfc78` (Prettier formatting), `fb438c5` (e2e fix). Nothing is dirty now; no spec-014 changes remain uncommitted, so the "protect dirty spec-014" requirement is satisfied vacuously — verified here rather than assumed.
- Stashes (left untouched, not part of this wave):
  - `stash@{0}`: wip-unrelated-rank-tracking (on feat/speckit-wave3-impl)
  - `stash@{1}`: preserve-unrelated-workstreams-KD-reports-dataforseo-r2cache-task15leftovers-2026-09-25 (on feat/integrated-intelligence)
  - `stash@{2}`: WIP: stash before clean tree (final-plan and opencode) (on feat/selectable-missing-ranking-states)

## Remotes

- `origin` → https://github.com/hatemsamirafifi/SEO-Dashboard.git — **reference repo per user clarification 2026-10-17**
- `upstream` → https://github.com/every-app/open-seo.git — fetch-only, never merged (locked decision §1.1)
- `open-seo` → https://github.com/hatemsamirafifi/open-seo.git (legacy duplicate of origin; unused)

## Fork / upstream divergence

- Merge-base with `upstream/main`: `9d19e439` = tag **v0.1.3** → the fork diverged from upstream right after v0.1.3.
- Upstream contains tags/releases **v0.1.4 → v0.1.13** not present locally (local tags stop at v0.1.8 for the fork's own line; these are the fork's own tags, not upstream's).
- Pending in Phase 1: confirm upstream v0.1.9–v0.1.13 tag range sits entirely inside `9d19e439..upstream/main` (127 commits) during the selective review.

## Implications for execution

- The upstream selective review window (§1.1) is `v0.1.4…v0.1.13` upstream history, with focus on v0.1.9–v0.1.13.
- All per-phase branches (`feat/p1-*`) branch from `fb438c5c` (this HEAD), not `809f142` as originally noted in the plan — the plan text is updated to defer to this manifest as the authoritative baseline at execution time.
- Spec numbers 015+ confirmed free: `specs/` ends at `014-competitor-gap-conditional`.
