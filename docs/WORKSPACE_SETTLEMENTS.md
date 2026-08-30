# Workspace settlements and live browsing

One Workspace maps to one stable persistent Cube Volume. The Volume is the
only authority for file bytes. A Run settlement stores only provider identity,
the Volume revision, environment identity and execution fence; it never walks
the tree or stores a path/hash catalog.

Multiple conversations may use the same Workspace. Tool Broker serializes a
conflicting physical Volume attachment where Cube requires it, while concurrent
human/Agent file operations retain ordinary Linux semantics. Terminal commit
advances the last observed settlement only when the current Attempt and fence
still match.

The Web Workspace browser is a live view:

- opening the panel lists the current root directory;
- expanding a folder lists only that directory;
- selecting a file reads only that file with a byte limit;
- `.git` and `.git-credentials` are omitted from the product browser;
- traversal and symlink escapes are rejected by the trusted Volume gateway.

Browsing does not create a Cube and does not read a historical settlement.
Changes made through a terminal or a warm Cube are therefore visible on the
next directory/file request.

Run settlement is not a backup system. Historical rollback requires an
explicit snapshot facility from the selected storage backend and is outside
the default product path. PiCloud does not derive change lists, create Patch
artifacts, or commit/push Git state; users and Agents manage Git directly.
