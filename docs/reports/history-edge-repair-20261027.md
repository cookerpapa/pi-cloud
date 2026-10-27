# Historical top-edge loading repair

Status: implemented; scoped Web publication pending. API, schema 202, history
budgets and dependencies remain unchanged.

Read-only inspection of the owner's galgame conversation found four visible
history pages, each taking about 35–50 ms and returning roughly 79–243 kB of
JSON. Browser reproduction of a fresh direct jump or rapid drag to the top issued
no history request during a 1.8-second wait. A second wheel gesture then fetched
the page in about 35–38 ms. Ordinary continuous wheel scrolling often works.
This identifies a missed frontend trigger, not a slow lifetime-log scan.

Entering frozen history schedules React state and returns before the new page
state is visible to the same scroll handler. Anchor-settling guards can also
consume the last event of a fast gesture. There was no independent check after
that state transition. A large-message fixture additionally showed that capturing
an offscreen overscan row while merely freezing the same content could move the
viewport away from its requested top position.

The reader now checks the older edge once after history/layout state settles.
It retains one timer only while settling, respects request epochs, the existing
in-flight gate and errors, and cancels on replacement/unmount. It is not periodic
queue polling and does not fetch all history eagerly. Returning to latest
invalidates the scheduled check. Freezing unchanged rows preserves the actual
user scroll offset; saved reading anchors must intersect the viewport.

The maintained PG/API/browser composition now reaches the edge without clicking
Load Earlier or issuing another gesture. The 8 MiB regression passes, including
bookmarks, delayed images, disclosure remount and later live output; its initial
automatic load completed in about 159 ms. The first intermediate implementation
still anchored an offscreen row and failed this test; the evidence is retained.
The existing four-page/byte budgets, scroll ownership and native context behavior
remain unchanged.

The final 1 GiB composition also passes: the automatic request began after about
81 ms and the page installed after about 199 ms, without another gesture. After
25 history requests, the browser retained four pages, 14 mounted blocks and
15.6–15.7 MiB of heap. Bookmark offset, late-image sizing, Tool disclosure and
600 subsequent live outputs preserve the reading position. The separate 17-case
stream/layout regression passes as well.

Publication uses the maintained Web-only operator. The existing composed-history
acceptance script is explicitly classified as operator/test code; public API,
protocol and runtime source changes remain outside that narrow scope.

Private evidence:
`deploy/production/runtime/release-evidence/history-paging-20261027/`.
