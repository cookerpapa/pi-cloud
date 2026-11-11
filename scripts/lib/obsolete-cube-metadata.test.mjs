import { expect, it } from "vitest";
import { templateLocatorRepair } from "./obsolete-cube-metadata.mjs";
const id = "tpl-123456789012345678901234";
function fixture() {
  return {
    selected: [id],
    protectedIds: ["current"],
    nodeId: "node",
    templates: [{ template_id: id, rootfs_artifact_id: "artifact", status: "READY" }],
    replicas: [
      {
        template_id: id,
        node_id: "node",
        node_ip: "10.0.0.1",
        artifact_id: "artifact",
        status: "READY",
      },
    ],
    jobs: [
      {
        job_id: "job",
        template_id: id,
        node_id: "",
        node_ip: "",
        artifact_id: "artifact",
        status: "READY",
      },
    ],
    placements: [{ artifact_id: "artifact", node_id: "node", node_ip: "10.0.0.1" }],
  };
}
it("clears only selected locators with exact address CAS and transactional assertions", () => {
  const result = templateLocatorRepair(fixture());
  expect(result.changed).toBe(2);
  expect(result.sql).toContain("AND node_ip='10.0.0.1'");
  expect(result.sql).toContain("IF(ROW_COUNT()=1,1,0)");
  expect(result.sql).not.toContain("DELETE");
  expect(result.sql).not.toContain("UPDATE t_cube_rootfs_artifact");
});
it.each(["protected", "shared", "other-node", "active-job", "missing"])(
  "refuses %s targets",
  (kind) => {
    const f = fixture();
    if (kind === "protected") f.protectedIds.push(id);
    if (kind === "shared")
      f.templates.push({ template_id: "current", rootfs_artifact_id: "artifact", status: "READY" });
    if (kind === "other-node") f.replicas[0].node_id = "other";
    if (kind === "active-job") f.jobs[0].status = "RUNNING";
    if (kind === "missing") f.templates = [];
    expect(() => templateLocatorRepair(f)).toThrow();
  },
);
it("does nothing to already repaired addresses", () => {
  const f = fixture();
  f.replicas[0].node_ip = "";
  f.placements[0].node_ip = "";
  expect(templateLocatorRepair(f).changed).toBe(0);
});
