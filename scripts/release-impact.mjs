import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { releaseImpact } from "./lib/release-impact.mjs";
let files;
const base = process.env.CI_BASE_SHA,
  head = process.env.CI_HEAD_SHA ?? "HEAD";
if (
  /^[a-f0-9]{40}$/.test(base ?? "") &&
  !/^0+$/.test(base) &&
  (/^[a-f0-9]{40}$/.test(head) || head === "HEAD")
) {
  try {
    files = execFileSync(
      "git",
      ["diff", "--name-only", "--no-renames", "-z", `${base}...${head}`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    )
      .split("\0")
      .filter(Boolean);
  } catch {
    /* Missing history must select the full gate. */
  }
}
const result = releaseImpact(files);
if (process.env.GITHUB_OUTPUT)
  for (const [key, value] of Object.entries(result))
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `${key}=${typeof value === "string" ? value : JSON.stringify(value)}\n`,
    );
console.log(JSON.stringify(result));
