import { satisfies, validRange } from "semver";

/** Only exact shrinkwrapped nodes replaced by the verified preparation qualify.
 * A newly reported advisory that still affects the installed version stays visible.
 */
export function classifyAuditFindings(vulnerabilities, replacements, installedVersion) {
  const remediated = new Map();
  for (const [name, finding] of Object.entries(vulnerabilities)) {
    const replacement = replacements.get(name);
    if (!replacement || finding.nodes?.length !== 1 || finding.nodes[0] !== replacement.node)
      continue;
    const via = finding.via;
    if (
      !Array.isArray(via) ||
      via.length === 0 ||
      !via.every(
        (advisory) =>
          typeof advisory === "object" &&
          advisory !== null &&
          typeof advisory.range === "string" &&
          validRange(advisory.range) !== null &&
          !satisfies(replacement.version, advisory.range, { includePrerelease: true }),
      )
    )
      continue;
    if (installedVersion(replacement.node) !== replacement.version) continue;
    remediated.set(name, {
      name,
      installedVersion: replacement.version,
      advisoryUrls: [...new Set(via.map((advisory) => advisory.url))],
      reason:
        "The exact shrinkwrapped node is replaced and verified; no reported affected range includes its installed version",
    });
  }
  const pi = vulnerabilities["@earendil-works/pi-coding-agent"];
  if (
    pi &&
    Array.isArray(pi.via) &&
    pi.via.length > 0 &&
    pi.via.every((name) => typeof name === "string" && remediated.has(name))
  ) {
    remediated.set(pi.name, {
      name: pi.name,
      installedVersion: installedVersion("node_modules/@earendil-works/pi-coding-agent"),
      advisoryUrls: [...new Set(pi.via.flatMap((name) => remediated.get(name).advisoryUrls))],
      reason:
        "Every dependency behind this aggregate finding was verified against its installed version and affected ranges",
    });
  }
  return {
    remediated: [...remediated.values()],
    remaining: Object.entries(vulnerabilities)
      .filter(([name]) => !remediated.has(name))
      .map(([name, finding]) => ({ ...finding, name })),
  };
}
