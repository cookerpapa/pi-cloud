import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyAuditFindings } from "./lib/dependency-audit.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

execFileSync(
  process.execPath,
  [join(repositoryRoot, "scripts", "harden-pi-dependencies.mjs"), "--check"],
  {
    cwd: repositoryRoot,
    stdio: "inherit",
  },
);

let auditResult;
let auditReport;
for (let attempt = 1; attempt <= 3; attempt += 1) {
  auditResult = spawnSync(npmCommand, ["audit", "--json", "--audit-level=high"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (auditResult.error) throw auditResult.error;

  try {
    const candidate = JSON.parse(auditResult.stdout);
    if (
      candidate?.error === undefined &&
      candidate?.metadata !== undefined &&
      candidate?.vulnerabilities !== undefined
    ) {
      auditReport = candidate;
      break;
    }
  } catch {
    // A truncated response is retried below and remains fail-closed.
  }
  if (attempt < 3) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, attempt * 2_000));
  }
}
if (auditResult === undefined || auditReport === undefined) {
  process.stderr.write(auditResult?.stderr ?? "");
  throw new Error("npm audit did not return a complete report after three attempts");
}

const replacements = new Map([
  [
    "brace-expansion",
    {
      node: "node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion",
      version: "5.0.12",
    },
  ],

]);
const { remediated, remaining } = classifyAuditFindings(
  auditReport.vulnerabilities,
  replacements,
  (node) => JSON.parse(readFileSync(join(repositoryRoot, node, "package.json"), "utf8")).version,
);

const blockingSeverities = new Set(["high", "critical"]);
const blocking = remaining.filter((vulnerability) =>
  blockingSeverities.has(vulnerability.severity),
);

console.log(
  JSON.stringify({
    securityAuditPassed: blocking.length === 0,
    auditLevel: "high",
    remediatedShrinkwrapFindings: remediated,
    remainingVulnerabilities: remaining.map((vulnerability) => ({
      name: vulnerability.name,
      severity: vulnerability.severity,
      nodes: vulnerability.nodes,
    })),
  }),
);

if (blocking.length > 0) {
  process.stderr.write(auditResult.stderr);
  process.exit(1);
}

if (auditResult.status !== 0 && remediated.length === 0) {
  process.stderr.write(auditResult.stderr);
  process.exit(auditResult.status ?? 1);
}
