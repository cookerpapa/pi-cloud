# 0169 — Confirmed Session recovery and restricted GitHub App entry

## Decision

Approved by the owner during the September 15 audit.

A failed Run remains failed. A quarantined Session may accept a **new** Run only
after the old Agent execution has positively stopped and its requested output
seal has committed. Lease expiry, a failed cancellation, and a requested but
uncommitted seal are not proof of execution exit. No old Run or Tool is replayed;
uncertain external effects remain UNKNOWN. Recovery preserves native history,
interruption facts and the existing physical-Session ownership boundary.

Remove the GitHub App installation-link and setup-callback endpoints. PiCloud
login plus one-time state does not establish GitHub permission to an installation.
Existing bound installation reads/Webhooks and environment-local GitHub/GitLab
credentials are separate capabilities and remain available. New GitHub App
onboarding requires a future, explicit GitHub user-authorization design; no
placeholder authorization or operator SQL workflow is introduced here.

## Scope

These changes do not add an execution scheduler, storage authority or recovery
replay mechanism. Tests must cover missing exit proof, missing seal, both facts
in either order, duplicate recovery, and absent installation endpoints.
