# ADR-0188: paginated conversation discovery

Status: accepted for implementation, 2026-09-26.

The conversation list keeps its 100-row page and tenant filter, but returns an
optional opaque `nextCursor`. GET `/v1/conversations?cursor=...` reads the next
page in descending `(last_active_at, id)` order. The cursor carries the exact
PostgreSQL timestamp precision and the last row ID; it is a bounded query
position, never an authorization credential. Every page authenticates and applies
the same tenant/archive filters. Invalid cursors fail with an input error.

The browser appends pages by Session identity and rejects stale page responses
after a newer list refresh. A refresh starts a new current list. Pagination is
not a snapshot across requests: later activity can reorder Sessions, and the
ordinary refresh discovers that activity. This does not change cursor-free SSE,
Turn-history paging, native Session storage or Run admission.

Acceptance: more than 100 owned conversations, equal timestamps with distinct
microseconds, no duplicate/missing IDs while the list is unchanged, tenant
isolation, invalid cursor, and the browser/API load-more path.
