# Single-request Live SERP diagnosis — 2026-11-05

Following the local account-queue migration, two user-triggered single-keyword
checks reported `PROVIDER_FAILURE`. A later, explicitly authorized diagnostic
request reached DataForSEO and returned `DATAFORSEO_ACCOUNT_PAUSED`.

## Confirmed evidence

- Target: existing `openseo-dev-app` Docker container and its existing local D1
  database. No remote deployment or migration was performed.
- Before diagnosis, both recent user runs had failed and the account coordination
  table contained zero rows. Their generic errors did not retain the original
  exception, so their exact pre-dispatch failure cause is not established.
- A temporary local-only probe loaded the actual SDK section barrel and exercised
  the actual account gate with a local callback. It completed successfully with
  zero provider requests. Its temporary dummy-account row was removed.
- The user then explicitly approved **one Live request only** for the same keyword
  shown in the screenshots. Both SDK HTTP retries and central provider retries
  were temporarily set to zero. The workflow already used a single-attempt step.
- A fresh browser selected exactly one keyword for one desktop check at depth 40
  and clicked **Check selected** once. An atomic local automation marker prevented
  accidental re-submission of that script.
- The resulting run was `fc61d08a-5cd0-44a4-b68c-d15babb0ced3`.
- Server logs recorded one account-slot acquisition, exactly **one** diagnostic
  Live fetch-dispatch marker, and the corresponding slot release.
- The persisted DataForSEO call had `attempt=1`, `max_retries=0`,
  `retryable=false`, `dispatched=true`, and
  `error_code=DATAFORSEO_ACCOUNT_PAUSED`. Serper and Zenserp were skipped as
  disabled; neither dispatched a request.
- The original typed API error explained that access had been temporarily paused
  as a precaution after unusual activity was detected, and directed the account
  holder to `support@dataforseo.com`.

The [official DataForSEO error reference](https://docs.dataforseo.com/v3/appendix/errors/)
documents that message as internal error `40201` and directs users to support to
resolve the pause. It lists rate-limit and insufficient-balance failures under
different codes. This evidence does **not** establish that the $1 trial balance
or a particular keyword batch caused the account flag.

## Result and limits

The observed diagnostic passed through the application's persistent account gate
and reached the provider. The confirmed remaining blocker is the provider-side
account pause. Switching bulk checks to Standard Queue and coordinating shared
accounts does not remove an existing provider-side pause.

The check correctly recorded one failed snapshot; it did not produce a new
ranking. Actual charge was not established from the persisted trace. Its `Paid`
label is a billing category, not proof of a deduction. No second Live request or
queued paid task was submitted during this investigation.

The older generic failures are not retrospectively attributed to a specific
runtime exception. Restarting the development container allowed the local probes
and the observed dispatch to complete, but that alone does not prove a precise
cause for the earlier failures.

## Cleanup and verification

- Temporary diagnostic code, temporary retry overrides, and the local probe were
  removed. `core.ts`, `providerResolver.ts`, and `api/health.ts` were restored to
  their original contents. No provider credentials or saved settings were changed.
- Only `openseo-dev-app` was restarted after cleanup. Existing project data and
  run history were retained, including the authorized diagnostic's failed result.
- After cleanup, `/api/health` returned `ok`, and the temporary probe query no
  longer exposed a diagnostic handler. Five projects, four tracking configs and
  1,903 tracking keywords remained present; no rank run or account slot was active.
- The real account coordination row remains, as designed; its slot was released.
- Existing DataForSEO client and SERP tests passed: **2 files, 33 tests**.
- Raw local browser evidence and diagnostic output were retained outside the
  repository; customer keyword text and credentials are not included here.

The next action is an account review by DataForSEO support. No support message was
sent by the agent.
