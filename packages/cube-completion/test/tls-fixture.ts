import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export async function testTls() {
  const directory = await mkdtemp(join(tmpdir(), "completion-tls-test-"));
  try {
    await promisify(execFile)(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:P-256",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost",
        "-keyout",
        "key.pem",
        "-out",
        "cert.pem",
      ],
      { cwd: directory },
    );
    return {
      key: await readFile(join(directory, "key.pem"), "utf8"),
      cert: await readFile(join(directory, "cert.pem"), "utf8"),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
