import type {
  ToolBrokerListWorkspaceDirectoryRequest,
  ToolBrokerReadWorkspaceFileRequest,
} from "@pi-cloud/protocol";
import type {
  CubeSandboxInstance,
  CubeSandboxRuntimeClient,
} from "./cubesandbox-runtime-client.ts";

// Code-owned, credential-free read-only helper. No resident guest controller
// and no template upgrade are needed for human-owned full-VM file browsing.
const SCRIPT = String.raw`
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const c = JSON.parse(Buffer.from(process.argv[2], 'base64').toString());
if (c.path.split('/').some(p=>p==='.git'||p==='.git-credentials')) throw Error('Hidden Workspace path');
const root = fs.realpathSync(c.root);
const inside = p => { const r = path.relative(root,p); return r === '' || (r !== '..' && !r.startsWith('../') && !path.isAbsolute(r)); };
const target = path.resolve(root,c.path);
if (!inside(target) || (target !== root && !inside(fs.realpathSync(path.dirname(target))))) throw Error('Workspace path escaped its root');
if (fs.lstatSync(target).isSymbolicLink()) throw Error('Workspace symlinks are not followed');
let result;
if (c.mode === 'list') {
  const directory = fs.opendirSync(target), entries = []; let item, truncated = false;
  try { while ((item = directory.readSync()) !== null) {
    if (item.name === '.git' || item.name === '.git-credentials') continue;
    if (entries.length === 4096) { truncated = true; break; }
    const kind = item.isDirectory() ? 'directory' : item.isSymbolicLink() ? 'symlink' : item.isFile() ? 'file' : null;
    if (!kind) continue;
    const stat = fs.lstatSync(path.join(target,item.name));
    entries.push({name:item.name,path:c.path ? c.path+'/'+item.name : item.name,kind,sizeBytes:stat.size,executable:(stat.mode & 73)!==0});
  } } finally { directory.closeSync(); }
  entries.sort((a,b)=>a.name.localeCompare(b.name)); result = {entries,truncated};
} else {
  const fd = fs.openSync(target,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try { const stat = fs.fstatSync(fd); if (!stat.isFile() || stat.size>c.maximumBytes) throw Error('Workspace file is unavailable or too large');
    const bytes = Buffer.alloc(c.maximumBytes+1); let size = 0, n;
    while (size<bytes.length && (n=fs.readSync(fd,bytes,size,bytes.length-size,null))>0) size+=n;
    if (size>c.maximumBytes) throw Error('Workspace file exceeded limit');
    const content = bytes.subarray(0,size); result = {content:content.toString('base64'),sha256:crypto.createHash('sha256').update(content).digest('hex'),sizeBytes:size,executable:(stat.mode & 73)!==0};
  } finally { fs.closeSync(fd); }
}
process.stdout.write(JSON.stringify(result));
`;

export async function browseCubeWorkspace(
  client: CubeSandboxRuntimeClient,
  instance: CubeSandboxInstance,
  request: ToolBrokerListWorkspaceDirectoryRequest | ToolBrokerReadWorkspaceFileRequest,
): Promise<Record<string, unknown>> {
  const config = {
    mode: request.type === "workspace.list_directory" ? "list" : "read",
    root: request.machine!.directory,
    path: request.path,
    maximumBytes: request.type === "workspace.read_file" ? request.maximumBytes : 0,
  };
  const result = await client.runCommand(instance, {
    command: `/usr/local/bin/node -e 'eval(Buffer.from(process.argv[1],"base64").toString())' '${Buffer.from(SCRIPT).toString("base64")}' '${Buffer.from(JSON.stringify(config)).toString("base64")}'`,
    cwd: "/",
    user: "root",
    timeoutMs: 15000,
    maximumOutputBytes:
      request.type === "workspace.read_file" ? request.maximumBytes * 2 + 8192 : 2 * 1024 * 1024,
  });
  if (result.exitCode !== 0) throw new Error("Machine Workspace read did not complete");
  return JSON.parse(result.stdout) as Record<string, unknown>;
}
