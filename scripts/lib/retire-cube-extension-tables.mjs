import assert from "node:assert/strict";

const sql = `DROP TABLE IF EXISTS t_pi_cloud_volume_hold;
DROP TABLE IF EXISTS t_pi_cloud_volume_node;
DROP TABLE IF EXISTS t_pi_cloud_volume_gate;
DROP TABLE IF EXISTS t_pi_cloud_allocation;
DROP TABLE IF EXISTS t_pi_cloud_allocation_clock;
DELETE FROM goose_db_version WHERE version_id IN (20261004000000,20261005000000);
DELETE FROM t_cubemaster_migration_fingerprint WHERE version IN (20261004000000,20261005000000);
`;

/** Destructive cutover only, after the old engines and all compute are gone.
 * No upstream table, credential, template or Workspace byte is removed. */
export async function retireCubeExtensionTables({
  kubectl,
  tag,
  assertDrained,
  assertNativeAbsent,
}) {
  assert.match(tag, /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/);
  await assertDrained();
  await assertNativeAbsent();
  const pods = JSON.parse(
    kubectl([
      "get",
      "pods",
      "-l",
      "app.kubernetes.io/component in (master,cube-node,cube-node-pvm)",
      "-o",
      "json",
    ]),
  ).items;
  let checked = 0;
  for (const pod of pods)
    for (const container of pod.spec?.containers ?? []) {
      const role =
        container.name === "cube-master"
          ? "cube-master"
          : container.name === "cubelet"
            ? "cubelet"
            : undefined;
      if (!role) continue;
      assert.equal(
        container.image.replace(/^docker\.io\//, ""),
        `pi-cloud/${role}:${tag}`,
        "An old Cube writer still exists",
      );
      assert(!pod.metadata.deletionTimestamp, "Native replacement has not settled");
      checked++;
    }
  assert(checked >= 2, "Native Master and node inventory is incomplete");
  const workload = JSON.parse(kubectl(["get", "statefulset", "cube-mysql", "-o", "json"]));
  const database = workload.spec.template.spec.containers[0].env.find(
    (e) => e.name === "MYSQL_DATABASE",
  )?.value;
  assert.match(database ?? "", /^[A-Za-z0-9_]{1,64}$/);
  // Only the existing container environment supplies the password. It is not
  // returned to Node, included in process arguments or written to a report.
  kubectl(
    [
      "exec",
      "-i",
      "cube-mysql-0",
      "--",
      "sh",
      "-eu",
      "-c",
      'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql --user=root --batch "$1"',
      "native-cutover",
      database,
    ],
    { input: sql },
  );
  return { nativeExtensionTablesRetired: 5, privateMigrationVersionsRetired: 2 };
}
