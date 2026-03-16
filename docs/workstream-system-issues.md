# Slack Workers Workstream System Issues / TBDs

## Purpose

This file tracks open questions, unresolved details, and explicitly superseded assumptions for the workstream-system redesign.

It is intentionally separate from the main spec so the main spec can remain clean and implementation-oriented without inventing precision that the thread history did not actually lock down.

## Source Materials for Implementers

Primary source-of-truth discussion history:

- `/Users/konark/.codex/sessions/2026/03/16/rollout-2026-03-16T13-33-37-019cf85a-ab2d-7170-8710-d4d5ef3e71ca.jsonl`
- `/Users/konark/.codex/sessions/2026/03/12/rollout-2026-03-12T17-25-02-019ce495-1810-7e72-ac71-30562e88c4f2.jsonl`

Useful local repos/docs for reconciliation and implementation:

- `/Users/konark/code/test/slack-codex-workers`
- `/Users/konark/code/test/codex`
- `/Users/konark/code/test/openclaw`
- `/Users/konark/code/test/imessage-codex-bridge`

Use the JSONL files above when resolving whether a question is truly open versus already settled in the thread.

## Superseded Assumptions

These earlier ideas were explored and then explicitly rejected or superseded:

### 1. `triage-handler` as a core pickup mode

Superseded by:

- one canonical spawn path for new work
- one separate wake-self path
- no foundational triage layer

### 2. Automatic reuse/routing back into existing public threads

Superseded by:

- new inbound -> new worker thread by default
- continuity recovered agentically through workstream context and prior Codex thread history

### 3. The earlier March 12 Slack bridge plan as the current redesign source of truth

The March 12 plan is historical context only.

The March 16 redesign thread is the active source of truth where the two conflict.

### 4. `no_op` as the conceptual model for silent completions

Superseded by:

- explicit per-turn notification control
- visible thread, optional final `@user`

### 5. Agent-facing workstream list/get tools as a primary discovery mechanism

Superseded by:

- filesystem-native discovery through root/nested `WORKSTREAM.md` plus folders
- bridge internal registry kept for correctness, not as the main user/agent interface

## Still Open / TBD

These are real open items that the spec should not pretend are fully pinned down.

## 1. Exact canonical item schema

Broad principles are settled:

- item semantic kinds are explicitly `note`, `request`, and `response`
- `response` is a first-class kind, not a special `note`
- item is the durable assignment artifact
- request/response are separate files
- items contain enough metadata and pointers to recover more context
- items stay small and are not full case journals

Not fully settled:

- exact frontmatter fields
- exact required vs optional metadata

## 2. Exact address syntax / persisted representation

Settled:

- the address model itself is not open
- addresses are workstream-first
- a specific public worker can be addressed as `workstream/<bridge-worker-key>`
- the same address model applies consistently to `from`, `to`, and `claimed_by`

Not fully settled:

- exact serialized syntax in persisted files if it differs in minor formatting details
- whether any helper aliases/views are needed in tooling or projections

## 3. Exact registration projection shape

Settled:

- canonical registrations are bridge-global
- workstreams get read-only local JSON projections

Open:

- exact JSON shape
- exact summary/detail balance
- exact relationship between local projection entries and bridge registration ids

## 4. Exact root/global and local hidden directory names beyond the conceptual buckets

Settled:

- root `.slack-workers/` is bridge-global infra
- workstream `.slack-workers/` is local protocol/runtime state

Open:

- exact filenames under root `.slack-workers/`
- exact filenames under workstream `.slack-workers/`
- whether local wake-self traces should exist and in what form

## 5. Default scaffold wording

Settled:

- create both `WORKSTREAM.md` and `AGENTS.md`
- keep them minimal, light, and editable

Open:

- exact template content
- exact prompts/placeholders
- how much the bridge writes versus leaves to immediate user/agent refinement

## 6. Exact registration tool argument schemas

Settled conceptually:

- `set_heartbeat(interval, description?)`
- `set_cron(schedule, target, description?)`
- `set_webhook(source, events, target, match?, description?)`
- plus list/get/disable

Open:

- exact schedule syntax
- exact `events` representation
- exact `match` shape
- whether `description` is optional or effectively expected

## 7. Webhook auth/body-limit/idempotency implementation details

Principles are settled:

- one bridge-owned ingress surface
- fail-closed auth
- body limits
- dedupe/idempotency before spawn/wake
- normalize minimally
- persist raw payloads durably

Open:

- exact auth configuration model
- exact idempotency key handling
- exact file layout for raw payload storage
- exact retention behavior for payload files

## 8. Retention / cleanup

Worth planning, but not locked:

- archived items
- raw fired-event payloads
- logs
- disabled registrations
- queue history

The current design is biased toward keeping data rather than aggressively cleaning it up, but the exact policy is TBD.

## 9. Extent of app-server v2 filesystem RPC adoption

Settled:

- the new v2 filesystem RPCs are real and relevant
- there is no general public path-watch RPC to assume

Open:

- whether to use local bridge filesystem access first and defer v2 FS RPC adoption
- or where to selectively lean on the new RPCs in implementation

## 10. Public/internal worker identity layering

Settled:

- public worker identity is the durable bridge/public concept
- backing Codex thread id is an execution detail

Open:

- how that settled public worker identity/address model should map onto current bridge worker keys during implementation
- whether any helper aliasing is useful in projections or operator-facing surfaces

## 11. Workstream registry exposure

Settled:

- bridge keeps an internal registry
- filesystem-native discovery is primary

Open:

- whether any admin-only or repair-oriented registry inspection tool should exist later
- how much partial-failure workstream creation state should be visible through docs/projections versus only the bridge

## Current Code / Target Architecture Tension Notes

These are not contradictions, but they are important seams to handle carefully during implementation:

### A. Current bridge is channel/thread-centric

Current code starts workers directly from Slack channel messages.

The target architecture makes workstreams first-class and routes spawn through canonical workstream landing.

The spec and implementation plan must clearly separate:

- current substrate we can retain
- future architecture we are building toward

### B. Current worker key format versus future address model

Current worker key is still the existing bridge key format.

The target model wants a settled workstream-first address model layered on top of a stable public worker identity.

This should be handled carefully in implementation rather than hand-waved in the spec.

## Auditor Focus

When auditing the main spec, focus especially on:

1. Whether any superseded assumptions leaked back in
2. Whether the spec accidentally invents precision for still-open details
3. Whether it clearly separates:
   - current implementation reality
   - target architecture
   - TBDs
4. Whether the root/general model remains a normal top-most workstream rather than drifting into a special control plane
5. Whether the spawn/wake split remains clean and no smart routing/triage logic sneaks back in
