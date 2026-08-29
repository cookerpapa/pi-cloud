# Workspace revisions

One Workspace maps to one stable persistent Cube Volume. A revision records a
bounded file/hash catalog, environment identity and fence. It does not contain
another copy of the Workspace bytes and is not a Git Diff.

The trusted Volume envelope is:

```text
volume root
├── platform generation/state
└── workspace/        <- mounted into Cube as /workspace
    └── .git/         <- optional user/Agent-managed repository state
```

Multiple conversations may use the same Workspace. Tool Broker serializes
physical Volume attachment where required, while concurrent user/Agent file
semantics remain ordinary Linux behavior. A terminal checkpoint advances only
when the expected base revision and current fence still match.

The source browser reads the current persistent Volume and verifies the selected
file's recorded digest. If it changed since the requested revision, the client
must refresh rather than receiving bytes mislabeled as historical state.

Normal Run settlement is not a backup system. Historical rollback/fork requires
an explicit snapshot facility from the selected storage backend and is outside
the current default product path.

PiCloud does not compare revisions into a change list, create Patch artifacts,
or commit/push Git state. Users and Agents manage Git directly.
