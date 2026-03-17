# Slack Workers Workstream System Spec

## Status

This document captures the current target architecture for the `slack-codex-workers` redesign.

It is based on:

- the March 16 redesign thread as the primary source of truth
- the earlier March 12 thread only as historical/current-system context
- explicit later decisions overriding earlier assumptions where they conflict

This spec is intentionally strict about the difference between:

- current implementation reality
- target architecture
- unresolved TBDs

## Source Materials for Implementers

Primary source-of-truth discussion history:

- `/Users/konark/.codex/sessions/2026/03/16/rollout-2026-03-16T13-33-37-019cf85a-ab2d-7170-8710-d4d5ef3e71ca.jsonl`
- `/Users/konark/.codex/sessions/2026/03/12/rollout-2026-03-12T17-25-02-019ce495-1810-7e72-ac71-30562e88c4f2.jsonl`

Local repos and docs that may be useful during implementation:

- Current bridge repo: `/Users/konark/code/test/slack-codex-workers`
- Current Codex repo: `/Users/konark/code/test/codex`
- OpenClaw reference repo: `/Users/konark/code/test/openclaw`
- iMessage bridge reference repo: `/Users/konark/code/test/imessage-codex-bridge`

Reference documents worth consulting when needed:

- This spec: `/Users/konark/code/test/slack-codex-workers/docs/workstream-system-spec.md`
- Open issues / TBDs: `/Users/konark/code/test/slack-codex-workers/docs/workstream-system-issues.md`
- Current `slack-codex-workers` README: `/Users/konark/code/test/slack-codex-workers/README.md`
- Codex app-server README: `/Users/konark/code/test/codex/codex-rs/app-server/README.md`

Implementation guidance:

- Treat the JSONL thread history above as the non-lossy source for detailed reasoning, revisions, and user intent.
- Treat the current repo state as implementation substrate, not as the final source of truth where it conflicts with the redesign decisions in those JSONL files.

## Purpose

`slack-codex-workers` should evolve from a Slack-thread-centric bridge into a workstream-oriented system where:

- Slack remains the human-facing control plane
- channels act as workstream homes
- public Slack threads act as durable worker/task surfaces
- workstreams are durable contexts with local docs, rules, and hidden protocol state
- agents remain mostly ephemeral execution units
- Codex built-in subagents remain internal by default
- the bridge stays thin and only owns the pieces that need hard correctness or durable infra

## Superseded Assumptions

The following earlier ideas are explicitly superseded and should not leak back into the design:

- `triage-handler` as a foundational pickup mode
- automatic routing/reuse back into existing public worker threads for new inbound events
- the original March 12 Slack bridge plan as the active source of truth for the redesign
- broad bridge-owned lifecycle logic for semantic coordination, case notes, or routing

The current design deliberately favors:

- one canonical spawn path
- one separate wake-self path
- new inbound work creating new public worker threads by default
- continuity recovered agentically through workstream context, local notes, external systems, and prior Codex thread history

## Current Implementation Reality

The current `slack-codex-workers` repo already provides:

- durable public Slack worker threads keyed by a stable bridge worker key
- replaceable backing Codex thread ids preserved across recovery
- Slack admin DM/control surface
- Slack-first thread routing for top-level channel posts and thread replies
- public child worker spawn tooling
- current notification/restart/status tooling
- `WORKSPACE_ROOT` as the canonical local root for current runtime state
- v2 app-server usage with `experimentalApi: true`

The current implementation does **not** yet provide:

- explicit workstream creation/registration
- nested workstream directories with `WORKSTREAM.md`
- per-workstream `.slack-workers/active` + `archive`
- canonical workstream items as the source of new work
- wakeup registrations
- global fired-event storage for cron/heartbeat/webhook
- the canonical spawn/wake runtime model described below

This spec therefore describes a target architecture to build toward, not a description of what the repo already implements.

## Core Model

### Slack as the Human-Facing Surface

Slack remains the primary place where humans see and steer work.

- channels are where workstreams live
- threads are where public workers/tasks live
- DMs remain the trusted admin/control surface

### Workstreams

Workstreams are the durable organizational contexts of the system.

Properties:

- explicitly created and registered
- nested under one `WORKSPACE_ROOT`
- usually mapped to a Slack channel
- hold local docs, local guidance, and local protocol artifacts
- may be nested to express organizational hierarchy and progressive disclosure

Workstreams are not inferred from arbitrary folders.

Workstreams are created only when the user asks for one. Agents may suggest them, but may not autonomously create them.

### Public Workers

Public workers are the durable user-facing task surfaces inside Slack.

Properties:

- represented by Slack threads
- observable and steerable by the user
- identified by a stable bridge/public worker identity
- backed by a Codex thread whose id is an execution detail and may change on recovery

Public worker identity is durable. Backing Codex thread id is not the public identity.

### Internal Codex Subagents

Codex built-in subagents remain internal.

They are not the public collaboration substrate by default.

They may be used by public workers internally, but the public system is built around workstreams and public worker threads, not around exposing internal subagent topology.

## Root Workspace and Hierarchy

### Root

`WORKSPACE_ROOT` is the canonical root for the entire system.

The root behaves like the top-most workstream.

It is not a separate special control plane, though it naturally carries broader/global guidance and acts like the executive/generalist layer.

### Root Slack Surface

The root/general Slack channel is the first usable surface.

It is useful for:

- top-level user requests
- broad coordination
- creating new workstreams
- work that does not yet belong in a more specialized workstream

Root/general should exist and be auto-created if missing during initialization.

### Recursive Hierarchy

Hierarchy is recursive and local-first.

- higher `WORKSTREAM.md` files may contain guidance that applies to descendants
- lower-level detail should not be eagerly bubbled upward
- specialized docs, APIs, skills, and norms should generally live at the lowest relevant workstream scope

## Filesystem Model

### Root Layout

At initialization, the root should contain only:

- root `WORKSTREAM.md`
- root `AGENTS.md`
- root `.slack-workers/`

No child workstreams or departments are created by default.

### Root `.slack-workers/`

The root hidden directory is split between:

- root-workstream local protocol/runtime state at the top level
- nested bridge-global infrastructure under a dedicated infra subdirectory

This keeps the root workstream shaped like a normal workstream while still preserving a clear bridge-owned infra boundary.

At the top level it should contain the root workstream's local protocol/runtime state, including:

- `active/`
- `archive/`
- local read-only projections such as `registrations.json`

Under a nested bridge infra directory, it should contain the canonical global runtime state, including:

- bridge-global DB, currently under `bridge/bridge.sqlite`
- fired-event payload storage
- logs
- runtime/global infra state as needed

The bridge infra subtree should not contain:

- workstream directories
- business/domain records
- child-workstream-specific artifacts

### Workstream Directories

Each workstream is a normal visible directory under `WORKSPACE_ROOT` or a parent workstream.

Each workstream directory contains:

- `WORKSTREAM.md`
- `AGENTS.md`
- `.slack-workers/`

Workstreams should use normal visible directory names. The bridge should not force them into a separate `WORKSTREAMS/` container or hide them inside a root hidden directory.

### Workstream `.slack-workers/`

Each workstream-local hidden directory contains only local protocol/runtime state.

At minimum:

- `active/`
- `archive/`
- local read-only projections such as `registrations.json`

It should not be used as a general dumping ground for domain/business data.

## Documents

### `WORKSTREAM.md`

`WORKSTREAM.md` describes how a workstream operates.

It should cover:

- purpose of the workstream
- what kinds of work belong here
- its Slack surface
- notification policy
- continuity/record-keeping guidance
- external-interface policy if relevant
- local protocol pointers
- child workstream map

It should be light, recursive, and navigational.

It should not become:

- a bridge-state dump
- a case-notes database
- a giant handbook of child-specific detail

### `AGENTS.md`

`AGENTS.md` describes how work in that scope should actually be done.

It should cover:

- substantive work norms
- style/quality expectations
- domain-specific guidance
- references to relevant local docs/skills

The default scaffold should be minimal and intentionally editable.

### Default Scaffold Behavior

When a new workstream is created, the bridge should generate:

- a light `WORKSTREAM.md` scaffold with obvious facts filled in
- a minimal `AGENTS.md` stub that points workers to `WORKSTREAM.md` and reserves space for substantive guidance

## Workstream Creation

### Ownership

Workstream creation is bridge-owned and explicit.

Only the user creates workstreams. Agents may suggest them.

In practice, workstream creation is exposed as a bridge tool that may be invoked from:

- worker/public threads
- the admin DM/control surface

Agents should only invoke that tool after the user has explicitly approved creating the workstream in the current conversation.

This is conversational/tool guidance, not a separate permission subsystem.

### Inputs

Workstream creation should take minimal inputs:

- `slug`
- `parent` optional
- `description` optional

Directory path is derived from parent.

Slack channel name is derived from slug.

### Flow

Recommended flow:

1. validate slug/parent and check for collisions
2. create the workstream directory
3. create local `.slack-workers/active` and `archive`
4. create `WORKSTREAM.md`
5. create `AGENTS.md`
6. create the Slack channel
7. register the workstream in bridge-global state
8. announce success in:
   - the Slack thread that initiated creation
   - the admin DM/control surface

### Channel Collisions

If the intended Slack channel already exists, fail fast.

Do not auto-link to an existing same-name channel in the first version.

### Failure Handling

Before public exposure:

- rollback local/private scaffolding freely

After Slack channel creation:

- preserve partial public state
- do not auto-delete the channel
- surface the failure clearly
- do not automate repair by default

## Workstream Discovery

Primary discovery is filesystem-native:

- root `WORKSTREAM.md`
- nested `WORKSTREAM.md`
- actual directories

The bridge should maintain an internal registry for correctness, but agent-facing `list_workstreams` / `get_workstream` tools are not first-class initially.

## Public Worker Model

### Identity

Public workers have:

- a stable bridge/public worker key
- a backing Codex thread id that may change across recovery

Public identity is what workstream items and other system artifacts should point to when they need to reference a specific public worker.

### Item / Thread Relationship

By default:

- one workstream item
- one public Slack worker thread

The public Slack thread is the human-facing surface for that item.

The item is the durable local protocol artifact.

### No Automatic Reuse

The system should not implement broad automatic reuse/routing into old public threads for new inbound events.

New inbound work should generally create a new worker/thread, and continuity should be recovered agentically instead of through a smart router.

## Workstream Items

### Role

An item is the durable assignment artifact for a unit of work.

It is not the full case journal, not the full transcript, and not the global source of business continuity.

### Semantic Model

The item semantic model is explicitly:

- `note`
- `request`
- `response`

`response` remains a first-class item kind.

It is not just a special kind of `note`.

The intent of the model is:

- `note` = addressed transient information / FYI / one-off context drop
- `request` = addressed work or ask
- `response` = an explicit answer/update to a request

These kinds are part of the settled design, not an open question.

### Address Model

Items use one central address model consistently for identity-bearing fields.

The address model is workstream-first:

- a workstream address is the base form
- a specific public worker may be addressed by adding the public worker key under that workstream

Conceptually:

- `workstream`
- `workstream/<bridge-worker-key>`

This same address model applies consistently to fields such as:

- `from`
- `to`
- `claimed_by`

The durable public worker identity is the bridge/public worker key, not the backing Codex thread id.

The exact serialized syntax/details remain implementation-level, but the semantic model is settled.

### Location

Items live in the workstream-local:

- `.slack-workers/active/`
- `.slack-workers/archive/`

### Lifecycle

The lifecycle should stay simple:

- active
- archived

Item status handles completion/failure semantics without introducing many more folders.

### One File Per Item

Each item is a separate file.

Requests and responses are separate files.

### Content

Items should contain:

- the assignment itself
- enough protocol metadata to reason about it
- pointers to recover more context if needed

Items should not become giant mutable transcripts or case journals.

### Continuity

Durable customer/contact/case notes should live wherever the workstream defines them to live:

- local workstream files
- external systems
- APIs

The bridge should not hardcode a universal case-notes system.

## Notifications

Visibility and notification are separate concerns.

Public work remains visible in Slack even when the user is not notified.

The notification control should be an explicit, turn-scoped boolean-shaped primitive, effectively:

- `set_notification(enabled: true|false)`

It applies to the current turn only.

It does not become sticky across workers or workstreams.

## Spawn / Wake Runtime Model

### Canonical Spawn Path

There is one canonical spawn path for all “new work lands here” flows.

All spawn-style work should feed the same internal workstream landing pipeline, regardless of source:

- user Slack ingress
- cron
- webhook
- worker dropoff into a workstream

Recommended spawn pipeline:

1. persist source event if applicable
2. create active item
3. create pending worker shell
4. create Slack top-level message/thread
5. create backing Codex thread
6. finalize linkage
7. start first turn

### Wake-Self Path

`wake_self` is the only separate continuation path.

It does not create a new public thread.

It delivers a new system-origin turn into the same public worker thread.

### Running Worker Behavior

If a wake fires while the worker is already running:

- queue it
- deliver it at the next idle point
- do not steer the running turn
- do not overlap turns

### Event Delivery Payload

When a registration fires, the bridge should deliver a bounded structured system event payload.

It should include:

- registration id
- trigger type
- target
- action
- fired-at
- trigger-specific summary/data
- enough pointers to recover more context if needed

It should not dump the full raw payload into the turn input by default.

## Wakeup Primitives

### Heartbeat

Heartbeat is:

- worker-only
- wake-self only
- broad periodic awareness/checking
- not precise scheduling
- not new-work spawning

### Cron

Cron is:

- precise scheduled work

By target:

- worker target -> wake_self
- workstream target -> spawn

### Webhook

Webhook is:

- external ingress

By target:

- worker target -> wake_self
- workstream target -> spawn

### Workstream Heartbeat

Workstream heartbeat is out of scope and intentionally dropped.

## Registrations

### Persistence

Registrations are durable objects that persist beyond the current turn.

Their lifecycle is primarily agentic.

The bridge should not over-own semantic expiry logic.

### Tool Surface

The first-class bridge tool surface is:

- `set_heartbeat(...)`
- `set_cron(...)`
- `set_webhook(...)`
- `disable_registration(...)`
- `list_registrations(...)`
- `get_registration(...)`
- `list_pending_wakes()`

### Registration Shape

Conceptually, a registration needs:

- target
- trigger
- action
- enabled
- trigger config
- description/purpose

### Creation / Update Semantics

`set_*` should:

- create by default
- update only when given an explicit registration id
- not perform fuzzy upsert/guessing

### Disable Semantics

`disable_registration` should disable, not delete.

Disabled registrations should remain inspectable.

### Discovery

`list_registrations()` should default to the current worker and its immediate workstream context, not parent/global scope.

`get_registration()` returns the full canonical registration details.

### Canonical Persistence

Canonical registration state is bridge-global and should live in bridge-owned infrastructure storage.

Current intended shape:

- canonical registrations live in bridge-global DB-backed infra under the nested bridge infra subtree
- each workstream gets a local read-only JSON projection such as `registrations.json`

### Local Projection

Canonical registration state is bridge-global.

Each workstream gets a local read-only projection, likely JSON.

The local projection is for discoverability, not editing.

## Wake Queue

Queued wakes are canonical bridge-global runtime state.

They are not a second local event store.

Workers should be able to inspect registrations and queued wakes, but not mutate/clear the queue directly in the first version.

## Webhook Ingress

### Ingress Surface

Use one bridge-owned webhook server / ingress surface.

### Ingress Discipline

Thin ingress model:

1. authenticate
2. enforce body limit
3. minimally normalize
4. dedupe/idempotency
5. persist first
6. then spawn or wake

### Payload Handling

Normalize only the outer event envelope, not arbitrary provider payloads.

Raw payloads should be stored durably.

Workers receive:

- a bounded event summary
- a pointer/path to the raw payload

Workers retrieve raw payloads by normal file access if needed.

### Matching

Webhook matching should be explicit and bounded:

- source/provider
- event type(s)
- optional narrow exact-match fields

Do not build a generic predicate/routing engine.

### Auth and Fanout

Prefer one secret per provider/source over one global secret or one per registration.

Allow multiple registration matches/fanout when an event genuinely applies to multiple targets.

## Global vs Local Hidden State

### Root `.slack-workers/`

Global bridge infrastructure only:

- DB
- events/raw payloads
- logs
- runtime/global infra state

### Workstream `.slack-workers/`

Local protocol/runtime state only:

- active items
- archived items
- local projections such as registrations

Do not turn either hidden layer into a junk drawer.

## Logs

Logs should exist as a first-class global bridge concern.

Purpose:

- observability
- diagnosis
- self-correction/improvement

Logs should be readable by agents when needed, but should not be default reading for every worker.

## Current Code vs Target Architecture

The current `slack-codex-workers` code already provides:

- durable public Slack worker threads
- stable bridge worker identity with replaceable backing Codex thread id
- Slack DM/admin surface
- v2 app-server usage
- current child worker spawning

The following parts of this spec are target architecture and not yet implemented:

- workstreams as explicit nested directories with `WORKSTREAM.md`
- workstream creation/registration
- canonical item/thread 1:1 landing path
- wakeup registration system
- bridge-global fired-event store for cron/heartbeat/webhooks
- local registration projections
- global/local hidden directory model as described here

## Open Items

Some details remain intentionally unresolved and belong in the separate issues/TBD file, including:

- exact canonical item schema
- exact local/global file names beyond the agreed conceptual buckets
- exact scaffold wording/templates
- exact registration JSON shape
- exact auth/body-limit/idempotency implementation details
- whether and where to lean on the new v2 filesystem RPCs in implementation
- retention/cleanup policy for archived items, events, logs, and registrations
