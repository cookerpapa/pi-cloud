import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const helmPath = spawnSync("which", ["helm"], { encoding: "utf8" });
assert.equal(helmPath.status, 0, "Helm is required for the real chart contract");
const temporary = mkdtempSync(join(tmpdir(), "pi-cloud-preflight-"));
const failures = [];
const defaultKeys = [
  "api-token",
  "cube-egress-config-token",
  "cubesandbox-api-key",
  "database-notification-url",
  "database-url",
  "metrics-token",
  "cli-proxy-api-key",
  "tool-broker-token",
  "tool-dispatch-token",
  "workspace-service-token",
  "workspace-terminal-token",
  "cube-persistent-state-key",
  "supervisor-enrollment-token",
  "supervisor-management-token",
  "workspace-volume-gateway-token",
  "ssh-host-key.pem",
];
const valid = {
  global: { imageRevision: "a".repeat(40) },
  external: { providerProxyUrl: "https://proxy.company.test" },
  sandboxPlane: {
    cube: { apiUrl: "https://cube.company.test", templateId: `tpl-${"a".repeat(24)}` },
  },
};

function scenario(name, options, verify) {
  const log = join(temporary, "calls.jsonl");
  writeFileSync(log, "");
  const values = structuredClone(valid);
  options.configure?.(values);
  writeFileSync(join(temporary, "values.yaml"), stringify(values));
  writeFileSync(
    join(temporary, "fixture.json"),
    JSON.stringify({
      secrets: { "pi-cloud-platform-secrets": defaultKeys },
      ...options.fixture,
    }),
  );
  const result = spawnSync(
    process.execPath,
    [
      "scripts/distributed-kubernetes.mjs",
      options.action ?? "preflight",
      "--namespace",
      "owned-test",
      "--values",
      join(temporary, "values.yaml"),
    ],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 60_000,
      env: {
        ...process.env,
        PATH: `${temporary}:${process.env.PATH}`,
        PREFLIGHT_FIXTURE: temporary,
      },
    },
  );
  const calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  try {
    verify(result, calls);
    process.stdout.write(`${name}: passed\n`);
  } catch (error) {
    failures.push(new Error(name, { cause: error }));
    process.stderr.write(`${name}: ${error.message}\n`);
  }
}
const mutations = (calls) =>
  calls.filter(([binary, verb]) =>
    binary === "helm" ? verb === "upgrade" : !["version", "cluster-info", "get"].includes(verb),
  );
const success = (result) => assert.equal(result.status, 0, result.stderr);
const readonly = (calls) => assert.deepEqual(mutations(calls), []);
const explicitDefaults = (values) => {
  values.global.existingSecret = "pi-cloud-platform-secrets";
  values.sandboxPlane.workspace = { existingClaim: "pi-cloud-workspaces-rwx" };
};

try {
  writeFileSync(
    join(temporary, "kubectl"),
    `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const directory = process.env.PREFLIGHT_FIXTURE, args = process.argv.slice(2);
fs.appendFileSync(path.join(directory,'calls.jsonl'),JSON.stringify(['kubectl',...args])+'\\n');
const fixture = JSON.parse(fs.readFileSync(path.join(directory,'fixture.json'),'utf8'));
function json(value){process.stdout.write(JSON.stringify(value));}
if(args[0]==='get'){
  const kind=args[1], name=args[2];
  if(fixture.deny?.includes(kind)){process.stderr.write('Forbidden fixture '+kind);process.exit(1);}
  if(kind==='nodes')json({items:[1,2].map(()=>({status:{conditions:[{type:'Ready',status:'True'}]}}))});
  else if(kind==='secret'){
    const keys=fixture.secrets[name]; if(!keys){process.stderr.write('Unexpected Secret '+name);process.exit(1);}
    json({data:Object.fromEntries(keys.map(key=>[key,'c3ludGhldGlj']))});
  }else if(kind==='pvc')json({spec:{accessModes:['ReadWriteMany']}});
  else json({metadata:{name}});
}
`,
    { mode: 0o700 },
  );
  writeFileSync(
    join(temporary, "helm"),
    `#!/usr/bin/env node
const fs=require('node:fs'), path=require('node:path'), cp=require('node:child_process');
const args=process.argv.slice(2);
fs.appendFileSync(path.join(process.env.PREFLIGHT_FIXTURE,'calls.jsonl'),JSON.stringify(['helm',...args])+'\\n');
if(args[0]!=='upgrade'){
 const result=cp.spawnSync(${JSON.stringify(helmPath.stdout.trim())},args,{stdio:'inherit'});
 process.exit(result.status ?? 1);
}
`,
    { mode: 0o700 },
  );

  scenario("inherited chart defaults", {}, (result, calls) => {
    success(result);
    readonly(calls);
  });
  scenario(
    "preflight does not write namespace labels",
    { configure: explicitDefaults },
    (result, calls) => {
      success(result);
      readonly(calls);
    },
  );
  scenario(
    "custom Worker Secret keys",
    {
      configure: (values) => {
        explicitDefaults(values);
        values["pi-workers"] = {
          database: {
            existingSecret: "worker-secrets",
            urlKey: "pool",
            notificationUrlKey: "direct",
          },
          credentials: { metricsTokenKey: "observe" },
        };
      },
      fixture: {
        secrets: {
          "pi-cloud-platform-secrets": defaultKeys,
          "worker-secrets": [
            "pool",
            "direct",
            "observe",
            "supervisor-enrollment-token",
            "supervisor-management-token",
            "tool-broker-token",
            "cli-proxy-api-key",
          ],
        },
      },
    },
    (result, calls) => {
      success(result);
      readonly(calls);
      assert(
        calls.some(
          (call) => call[1] === "get" && call[2] === "secret" && call[3] === "worker-secrets",
        ),
      );
    },
  );
  scenario(
    "missing SSH host key",
    {
      configure: explicitDefaults,
      fixture: {
        secrets: {
          "pi-cloud-platform-secrets": defaultKeys.filter((key) => key !== "ssh-host-key.pem"),
        },
      },
    },
    (result, calls) => {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /ssh-host-key.pem/);
      readonly(calls);
    },
  );
  scenario(
    "custom platform database keys",
    {
      configure: (values) => {
        explicitDefaults(values);
        values.external.database = {
          secretKey: "pool",
          notificationSecretKey: "direct",
          apiTokenSecretKey: "bootstrap-api",
        };
        values["pi-workers"] = { database: { urlKey: "pool", notificationUrlKey: "direct" } };
      },
      fixture: {
        secrets: {
          "pi-cloud-platform-secrets": [
            ...defaultKeys.filter(
              (key) => !["database-url", "database-notification-url", "api-token"].includes(key),
            ),
            "pool",
            "direct",
            "bootstrap-api",
          ],
        },
      },
    },
    (result, calls) => {
      success(result);
      readonly(calls);
    },
  );
  scenario(
    "GitHub optional Secret dependency",
    {
      configure: (values) => {
        explicitDefaults(values);
        values.controlPlane = {
          sourceControl: {
            github: { enabled: true, appId: "123", privateKeySecretKey: "github-private" },
          },
        };
      },
    },
    (result, calls) => {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /github-private/);
      readonly(calls);
    },
  );
  scenario(
    "disabled components need no storage or autoscaler",
    {
      configure: (values) => {
        explicitDefaults(values);
        values.piWorkersEnabled = false;
        values.sandboxPlaneEnabled = false;
        values.sshGateway = { enabled: false };
        values.bootstrap = { enabled: false };
        values.controlPlane = { autoscaling: { enabled: false } };
        values.web = { autoscaling: { enabled: false } };
      },
      fixture: {
        deny: ["pvc", "crd", "apiservice"],
        secrets: {
          "pi-cloud-platform-secrets": [
            "database-url",
            "database-notification-url",
            "tool-dispatch-token",
            "supervisor-enrollment-token",
            "supervisor-management-token",
            "cube-egress-config-token",
            "workspace-service-token",
            "workspace-terminal-token",
            "metrics-token",
          ],
        },
      },
    },
    (result, calls) => {
      success(result);
      readonly(calls);
    },
  );
  scenario(
    "namespace authorization error does not create it",
    {
      configure: explicitDefaults,
      fixture: { deny: ["namespace"] },
    },
    (result, calls) => {
      assert.notEqual(result.status, 0);
      readonly(calls);
    },
  );
  scenario(
    "failed deploy preflight has no mutations",
    {
      action: "deploy",
      configure: explicitDefaults,
      fixture: { secrets: { "pi-cloud-platform-secrets": [] } },
    },
    (result, calls) => {
      assert.notEqual(result.status, 0);
      readonly(calls);
    },
  );
  scenario(
    "successful deploy applies configured trust labels after checks",
    {
      action: "deploy",
      configure: (values) => {
        explicitDefaults(values);
        values.networkPolicy = {
          trustedNamespaceLabel: { key: "company.test/platform", value: "allowed" },
        };
        values["pi-workers"] = {
          networkPolicy: {
            trustedNamespaceLabel: { key: "company.test/workers", value: "allowed" },
          },
        };
      },
    },
    (result, calls) => {
      success(result);
      assert.deepEqual(
        mutations(calls).map((call) => call.slice(0, 2)),
        [
          ["kubectl", "label"],
          ["helm", "upgrade"],
        ],
      );
      const labelIndex = calls.findIndex((call) => call[1] === "label");
      assert(calls[labelIndex].includes("company.test/platform=allowed"));
      assert(calls[labelIndex].includes("company.test/workers=allowed"));
      assert(calls.slice(labelIndex).every((call) => call[1] !== "get"));
    },
  );
  scenario(
    "conflicting namespace labels are rejected without writes",
    {
      configure: (values) => {
        values["pi-workers"] = {
          networkPolicy: {
            trustedNamespaceLabel: { key: "pi-cloud.io/trusted-plane", value: "different" },
          },
        };
      },
    },
    (result, calls) => {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /disagree on namespace label/);
      readonly(calls);
    },
  );
  scenario(
    "Ingress TLS Secret must exist",
    {
      configure: (values) => {
        values.web = { ingress: { enabled: true, tlsSecretName: "web-tls" } };
      },
    },
    (result, calls) => {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /web-tls/);
      readonly(calls);
    },
  );
} finally {
  rmSync(temporary, { recursive: true });
}
if (failures.length) throw new AggregateError(failures, "Distributed preflight contracts failed");
