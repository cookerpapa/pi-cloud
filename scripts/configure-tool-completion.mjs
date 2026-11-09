import { X509Certificate, createPrivateKey, createPublicKey } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { kubectl } from "./lib/production-kubernetes.mjs";

// Reuse the installed Cube CA. Only its public certificate enters a Guest;
// private material stays in Kubernetes Secrets and this short-lived directory.
const capture = (args, options) => {
  try {
    return kubectl(args, options);
  } catch {
    throw new Error(
      "Completion TLS credential reconciliation failed; private command output omitted",
    );
  }
};
const name = "pi-cloud-tool-completion-tls";
const host = "tool-completion";
const existing = JSON.parse(
  capture(["get", "secret", name, "--ignore-not-found", "-o", "json"]) || "null",
);
let valid = false;
if (existing?.data) {
  try {
    const certificate = new X509Certificate(Buffer.from(existing.data["tls.crt"], "base64"));
    const key = createPrivateKey(Buffer.from(existing.data["tls.key"], "base64"));
    valid =
      !!certificate.checkHost(host) &&
      Date.parse(certificate.validTo) > Date.now() + 30 * 86400000 &&
      certificate.publicKey
        .export({ type: "spki", format: "der" })
        .equals(createPublicKey(key).export({ type: "spki", format: "der" }));
  } catch {
    /* Matched replacement refreshes an invalid or expiring certificate. */
  }
}
if (!valid) {
  const root = JSON.parse(capture(["get", "secret", "cube-egress-ca", "-o", "json"]));
  const directory = await mkdtemp(join(tmpdir(), "picloud-completion-tls-"));
  const run = promisify(execFile);
  try {
    for (const [file, source] of [
      ["ca.crt", "cube-root-ca.crt"],
      ["ca.key", "cube-root-ca.key"],
    ]) {
      if (!root.data?.[source]) throw new Error("Installed Cube CA is unavailable");
      await writeFile(join(directory, file), Buffer.from(root.data[source], "base64"), {
        mode: 0o600,
      });
    }
    await writeFile(
      join(directory, "extensions"),
      [
        "basicConstraints=critical,CA:FALSE",
        "keyUsage=critical,digitalSignature,keyEncipherment",
        "extendedKeyUsage=serverAuth",
        "subjectAltName=DNS:tool-completion,DNS:tool-completion.cube-system,DNS:tool-completion.cube-system.svc,DNS:tool-completion.cube-system.svc.cluster.local",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const execute = async (args) => {
      try {
        await run("openssl", args, { cwd: directory });
      } catch {
        throw new Error("Completion certificate generation failed; private output omitted");
      }
    };
    await execute([
      "req",
      "-new",
      "-newkey",
      "rsa:3072",
      "-nodes",
      "-subj",
      `/CN=${host}`,
      "-keyout",
      "tls.key",
      "-out",
      "server.csr",
    ]);
    await execute([
      "x509",
      "-req",
      "-in",
      "server.csr",
      "-CA",
      "ca.crt",
      "-CAkey",
      "ca.key",
      "-CAcreateserial",
      "-out",
      "tls.crt",
      "-days",
      "365",
      "-sha256",
      "-extfile",
      "extensions",
    ]);
    const data = Object.fromEntries(
      await Promise.all(
        ["tls.crt", "tls.key", "ca.crt"].map(async (file) => [
          file,
          (await readFile(join(directory, file))).toString("base64"),
        ]),
      ),
    );
    capture(["apply", "-f", "-"], {
      input: JSON.stringify({
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name },
        type: "kubernetes.io/tls",
        data,
      }),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
process.stdout.write("Tool completion HTTPS credential is ready\n");
