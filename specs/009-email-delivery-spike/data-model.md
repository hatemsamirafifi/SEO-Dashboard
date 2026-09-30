# Data Model: Email Delivery Infrastructure Spike

**Feature**: `009-email-delivery-spike` | **Date**: 2026-09-30

No persisted tables. Models below are the verdict artifact and checklist contracts.

## DeliveryVerdict

The single authoritative G6 record.

| Field         | Type                   | Rules                                                                            |
| ------------- | ---------------------- | -------------------------------------------------------------------------------- |
| verdict       | enum                   | `EMAIL_DELIVERY_READY` \| `EMAIL_DELIVERY_BLOCKED` — exactly one, no third state |
| recordedAt    | string (ISO)           | When the verdict was recorded                                                    |
| timeBox       | object                 | Declared start + deadline; expiry with unmarked items ⇒ BLOCKED                  |
| evidenceRef   | string                 | Pointer to the evidence checklist below (same artifact)                          |
| prerequisites | RequiredPrerequisite[] | Changes 012 (or later work) must make; recorded, never implemented here          |

## EvidenceChecklist

One entry per verified delivery question.

| Field  | Type   | Rules                                                                                                                           |
| ------ | ------ | ------------------------------------------------------------------------------------------------------------------------------- |
| item   | enum   | quota_limits \| sender_identity \| template_ownership \| failure_semantics \| duplicate_send \| missing_credentials_degradation |
| state  | enum   | observed \| not_verified (with reason; counts against READY)                                                                    |
| method | enum   | live_test \| log_excerpt \| documented_behavior                                                                                 |
| detail | string | Secret-free observation (no keys, no real recipient addresses)                                                                  |

**Validation**: zero unmarked items at record time; every `observed` claim carries a method; every `not_verified` carries a reason.

## RequiredPrerequisite

| Field       | Type   | Rules                                            |
| ----------- | ------ | ------------------------------------------------ |
| description | string | What must change before scheduled delivery ships |
| ownedBy     | string | Which package owns it (012 unless stated)        |

## Relationships

`DeliveryVerdict 1—1 EvidenceChecklist`; `DeliveryVerdict 1—* RequiredPrerequisite`. Spec 012 reads the verdict as its planning precondition.
