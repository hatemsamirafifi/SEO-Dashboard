# Contract: Delivery Verdict

**Feature**: `009-email-delivery-spike` | **Date**: 2026-09-30

The G6 verdict contract read by spec 012 and the team. See [research](research.md), [data model](data-model.md).

## `verdict.md`

- **Location**: `specs/009-email-delivery-spike/verdict.md` (the deliverable; written by the spike run, not by planning).
- **Content**: exactly one verdict value (`EMAIL_DELIVERY_READY` or `EMAIL_DELIVERY_BLOCKED`), recorded timestamp, declared time-box, the full evidence checklist (every item observed-with-evidence or not-verified-with-reason), and any required-prerequisites for 012.
- **Invariants**:
  - Exactly one verdict value exists; no third state, no hedging language that re-opens the decision.
  - Zero unmarked checklist items; zero unbacked assertions; zero secrets (no keys, no real recipient addresses).
  - An incomplete checklist at time-box expiry yields BLOCKED with the incomplete items named.
  - Required-prerequisites are recorded for 012 and never implemented by the spike.

## 012 gate wiring

- Spec 012 (scheduled reports) may enter planning only when `verdict.md` exists with `EMAIL_DELIVERY_READY`.
- On `EMAIL_DELIVERY_BLOCKED`, 012 remains Draft with the recorded reason discoverable from the verdict; a later verified spike attempt may supersede the verdict (new timestamp, new evidence — never an edit that rewrites history).

## Records the spike must NOT create

- No production delivery code paths, no provider changes, no altered email flows, no scheduled-send code. Merged artifacts from the spike are evidence tooling and documentation only (verifiable by reviewing what the spike run actually merged).

## Stability promise

The verdict vocabulary (`EMAIL_DELIVERY_READY` / `EMAIL_DELIVERY_BLOCKED`) and the gate rule are frozen; 012's planning precondition references this contract, not the spike's working notes.
