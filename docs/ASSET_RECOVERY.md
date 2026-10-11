# Conversation and image recovery

[ADR-0237](adr/0237-private-pilot-asset-recovery.md) defines this cold operator
procedure. It preserves retained native history and authoritative current input state, associated product/account metadata
and immutable image attachments. Ordinary uploaded files belong to the Workspace;
their bytes and running programs are not backed up here. Restored Sessions use
fresh empty Workspaces. No old task, VM, Kafka queue or lease is resumed by restore.

The operator needs Docker for the pinned PostgreSQL client image, access to PG/S3,
and this matching checkout (`npm ci`). This is a database recovery procedure for
trusted owner-generated archives, not a public import endpoint. It does not add
a second runtime storage backend. The PG archive contains private conversation and
account/configuration data; store it privately and do not put it in Git. Deployment
secrets and external provider credentials require the owner's separate secure copy.

## Make a recovery point

1. Stop new submissions. Allow Runs and their seals to finish. Stop Workers, keep
   the Control Plane running until all Session writers are closed, then stop the
   Control Plane/Volume Gateway and other application writers. Preserve the existing
   replica counts for restart. PG and attachment S3 remain running. This is a
   maintenance window; do not present the table locks as an online-backup feature.
2. In a private directory, make an operator config whose paths point to existing
   private credential files (database URL must be reachable from this host):

   ```json
   {
     "databaseUrlFile": "/private/source-database-url",
     "images": {
       "endpoint": "http://source-s3:8333",
       "bucket": "pi-cloud-session-images",
       "region": "us-east-1",
       "credentialsFile": "/private/source-s3-credentials.json"
     }
   }
   ```

3. Run the maintained command; the destination must not exist:

   ```sh
   node --import tsx scripts/session-assets.mjs backup --config /private/source.json --directory /backups/pi-cloud-20261007
   node --import tsx scripts/session-assets.mjs verify --directory /backups/pi-cloud-20261007
   ```

   The tool refuses unsettled Runs, pending native tasks, open writers and
   unprojected seals. It locks the PG tables against mutation, uses one exported
   PG snapshot, streams referenced images and checks every hash/length. An
   incomplete directory is never published as a completed backup. Restore service
   replica counts after backup, including after a failed attempt.
4. Copy the completed directory off this machine, retaining private permissions,
   and run `verify` on that copy. Record its timestamp/location and verification
   outcome; neither transcripts nor credentials belong in an acceptance report.

## Restore into new infrastructure

Prepare an **empty offline database and empty S3 bucket** and a separate private
config for them. Use the schema and Pi/Chord pins matching the bundle. Do not start the
new Control Plane or Workers yet; do not point them at the old deployment's Cube,
Kafka or Workspace storage. Installation secrets/provider routing must target the
new installation. A database dump does not supply those external secrets.

```sh
node --import tsx scripts/session-assets.mjs restore --config /private/target.json --directory /backups/pi-cloud-20261007
```

The tool verifies local assets, copies and reads back image bytes, then streams
`pg_restore` and the explicit authority reset through a single PG transaction.
It clears operational queues, Worker leases, Cube bindings/capsules and Kafka
offsets, and assigns fresh empty Workspaces. Canonical native log bytes, history
and image references stay unchanged. The old Workspace rows are retained only
for historical foreign keys, marked already purged in this new installation;
no source VM/Volume is deleted or certified absent by this action.

If restore fails, keep the target offline. SQL failure rolls back the database;
an interrupted final receipt may still leave a committed restore, so the tool
retains uploaded images for inspection. Recreate the **owned target** database
and bucket before a clean retry. Never reset the source to retry restoration.

After a successful report, initialize the new deployment's external configuration,
confirm that its Cube/Kafka/S3 endpoints are independent, then start its services.
Open a restored conversation, view an original image and send a new prompt. That
request gets a new Run and PG execution grant. The model should be told that the
Workspace is fresh; old file paths in history are historical, not restored files.

## Executable drill and limits

```sh
npx vitest run scripts/lib/asset-recovery.test.mjs --maxWorkers=1 --testTimeout=90000 --hookTimeout=120000
```

The drill owns its PG container and two separate SeaweedFS containers, uses the
production pins, destroys the source database/object server before reading the
target, and exercises the actual dump/restore and ordinary new-Run admission.
Model/Tool execution in the admission assertion is a controlled backend; it does
not claim a new paid Luna/Cube end-to-end run. This is a same-host storage recovery
drill, not a physical host-loss test. Backup scheduling and off-machine retention
remain explicit operator duties during [the pilot](PRIVATE_PILOT.md).
