# PiCloud database

This package owns the typed PostgreSQL schema, Kysely client and ordered
migrations. PostgreSQL stores product/control state and canonical Pi Session
records; it does not own the Kafka AcceptedFact log or Workspace file bytes.

The current schema enforces tenant-consistent foreign keys, idempotent command
intake, Session ordering, Run/Attempt leases and fences, Pi SessionStorage,
Workspace revisions, Tool Broker ownership, Subagent relations and
administrator/model configuration. Application state machines still own legal
transition order.

Migration sources preserve pre-release history so a new database can replay
from migration 001. Historical table/column names are not current architecture
documentation; use the root README and `docs/ARCHITECTURE.md` for that.

```bash
DATABASE_URL=postgresql://... npm run db:migrate
DATABASE_URL=postgresql://... npm run db:migrate:down
npm test --workspace @pi-cloud/database
```

The migration CLI never prints `DATABASE_URL`. PGlite is test-only; production
uses PostgreSQL through `pg`/Kysely.
