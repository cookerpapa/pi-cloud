import assert from "node:assert/strict";

const safe = (value) => {
  assert.match(value, /^[A-Za-z0-9_.:-]{1,256}$/);
  return `'${value}'`;
};
export function templateLocatorRepair({
  selected,
  protectedIds,
  templates,
  replicas,
  jobs,
  placements,
  nodeId,
}) {
  assert(selected.length > 0 && new Set(selected).size === selected.length);
  for (const id of selected) {
    assert.match(id, /^tpl-[a-z0-9]{24}$/);
    assert(!protectedIds.includes(id), "Current template cannot be retired");
  }
  const retained = templates.filter((row) => !selected.includes(row.template_id));
  const targets = templates.filter((row) => selected.includes(row.template_id));
  const artifacts = targets.map((row) => row.rootfs_artifact_id);
  assert(targets.length === selected.length, "Selected template disappeared");
  assert(
    targets.every((row) => row.status === "READY"),
    "Template is not settled",
  );
  assert(new Set(artifacts).size === targets.length && artifacts.every(Boolean));
  assert(
    !retained.some((row) => artifacts.includes(row.rootfs_artifact_id)),
    "Shared artifact is still referenced",
  );
  assert(
    !replicas.some(
      (row) => !selected.includes(row.template_id) && artifacts.includes(row.artifact_id),
    ),
    "Shared replica artifact",
  );
  assert(
    !jobs.some((row) => !selected.includes(row.template_id) && artifacts.includes(row.artifact_id)),
    "Shared job artifact",
  );
  const selectedJobs = jobs.filter((row) => selected.includes(row.template_id));
  assert(
    selectedJobs.every((row) => ["READY", "FAILED", "ERROR", "CANCELLED"].includes(row.status)),
    "Template job is active",
  );
  const rows = [
    ...replicas
      .filter((row) => selected.includes(row.template_id))
      .map((row) => ({
        table: "t_cube_template_replica",
        key: { template_id: row.template_id, node_id: row.node_id },
        ...row,
      })),
    ...selectedJobs.map((row) => ({
      table: "t_cube_template_image_job",
      key: { job_id: row.job_id },
      ...row,
    })),
    ...placements
      .filter((row) => artifacts.includes(row.artifact_id))
      .map((row) => ({
        table: "t_cube_artifact_node_placement",
        key: { artifact_id: row.artifact_id, node_id: row.node_id },
        ...row,
      })),
  ];
  assert(
    rows.some((row) => row.table === "t_cube_template_replica"),
    "Replica inventory missing",
  );
  for (const row of rows)
    assert(
      row.node_id === nodeId || (!row.node_id && !row.node_ip),
      "Template points at a different node",
    );
  const updates = rows
    .filter((row) => row.node_ip)
    .map((row) => {
      const where = [...Object.entries(row.key), ["node_ip", row.node_ip]]
        .map(([key, value]) => `${key}=${safe(value)}`)
        .join(" AND ");
      return `UPDATE ${row.table} SET node_ip='' WHERE ${where};\nINSERT INTO cleanup_guard VALUES (IF(ROW_COUNT()=1,1,0));`;
    });
  // CHECK failures abort this batch; the CLI closes its connection and the
  // transaction rolls back. Never use --force. All native writers stay stopped.
  const guards = targets.map(
    (row) =>
      `INSERT INTO cleanup_guard SELECT IF(COUNT(*)=1,1,0) FROM t_cube_template_definition WHERE template_id=${safe(row.template_id)} AND rootfs_artifact_id=${safe(row.rootfs_artifact_id)} AND status='READY' AND deleted_at IS NULL;`,
  );
  return {
    changed: updates.length,
    sql: `CREATE TEMPORARY TABLE cleanup_guard (ok INT CHECK (ok=1));\nSTART TRANSACTION;\n${guards.join("\n")}\n${updates.join("\n")}\nCOMMIT;\n`,
    templateIds: selected,
  };
}

export const templateInventoryQueries = {
  templates:
    "SELECT template_id,rootfs_artifact_id,status FROM t_cube_template_definition WHERE deleted_at IS NULL",
  replicas:
    "SELECT template_id,node_id,node_ip,artifact_id,status FROM t_cube_template_replica WHERE deleted_at IS NULL",
  jobs: "SELECT job_id,template_id,node_id,node_ip,artifact_id,status FROM t_cube_template_image_job WHERE deleted_at IS NULL",
  placements: "SELECT artifact_id,node_id,node_ip FROM t_cube_artifact_node_placement",
};

export function parseMysqlRows(text) {
  const [header, ...lines] = text.trimEnd().split("\n");
  const fields = header.split("\t");
  return lines
    .filter(Boolean)
    .map((line) =>
      Object.fromEntries(line.split("\t").map((value, index) => [fields[index], value])),
    );
}
