# ADR-0125: PostgreSQL authority before JetStream

## Status

Accepted on 2026-08-26. This refines ADR-0124 without changing PostgreSQL as
the sole ExecutionGrant authority.

## Context

Browser-visible Agent events already cross one transaction-scoped
ExecutionGrant check before their R=3 JetStream PubAck. Downstream SSE readers
therefore trust the retained event and never query the current lease again.

Pi Session mutations used the opposite ordering: a trusted Worker published an
envelope containing its ExecutionGrant directly to a second JetStream Stream,
then the PostgreSQL Projector checked whether that Grant was still current when
it eventually applied the mutation. This made JetStream hold unaccepted work,
gave Workers direct broker access and allowed a mutation accepted while a Run
was current to be rejected merely because projection happened after expiry.

Moving only lease renewal to Redis, ZooKeeper or etcd would create a second
current-owner authority beside PostgreSQL Run, Session and Workspace state.
It would not make terminal PostgreSQL commits atomic with that external lease.

## Decision

PostgreSQL table `execution_grants` remains the only current execution
authority. There are three protected effect boundaries:

1. Agent-event and Pi-Session-mutation Ingest validate the current Grant before
   publishing an accepted record to JetStream.
2. Tool Broker validates the same Grant when reserving an activation and before
   starting each durable Tool operation.
3. terminal Run and Workspace commits validate the same Grant in their
   PostgreSQL transaction.

Workers send Pi Session mutations to a service-authenticated Control Plane
Ingest endpoint. The Ingest groups concurrent requests, locks matching Grant
rows once, validates exact Tenant/Session/Run/Turn/execution identity and
expiry, then publishes schema-v2 accepted envelopes to the Session-keyed R=3
Stream. Worker credentials cannot publish that Stream directly.

Accepted envelopes contain immutable execution identity for audit/result
correlation but no ExecutionGrant. JetStream PubAck is the irrevocable
authority-acceptance boundary. The Projector performs only parsing, ordered
idempotent SessionStorage mutation and result recording. It does not recheck a
lease that may legitimately have expired after acceptance.

Projection barriers retain their meaning because one durable ordered consumer
applies every earlier accepted mutation before completing the later barrier.
A replacement Worker obtains a higher PostgreSQL generation, submits a new
barrier and reads SessionStorage only after it completes.

ExecutionGrant heartbeat renewal stays in PostgreSQL. A Worker heartbeat is
validated once and renews all accepted Grants and Run executions with
set-oriented statements instead of one query/update sequence per active Run.

## Failure semantics

- stale Grant before Ingest: reject without a JetStream write;
- Ingest crash after PubAck: retry the stable mutation ID; JetStream deduplicates
  and the Worker may observe the idempotent projection result;
- Grant expires after PubAck: Projector still applies the already accepted
  mutation;
- Projector crash after PostgreSQL commit: explicit ACK redelivery returns the
  stored mutation result without repeating the semantic effect;
- Worker loss with older accepted mutations: a new Grant's barrier waits until
  those mutations are applied; later stale publications are rejected;
- PostgreSQL unavailable: no new execution authority or accepted effects are
  issued, matching the inability to commit canonical Session/Run state.

## Consequences

JetStream becomes a log of accepted facts on both paths. SSE and SessionStorage
Projectors do not become lease clients. Pi Workers no longer need NATS network
access or server configuration. PostgreSQL remains on the acceptance path, but
authority queries and heartbeat renewals are batched rather than multiplied by
text fragments or active Runs.
