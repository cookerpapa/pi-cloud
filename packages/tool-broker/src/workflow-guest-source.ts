/** This source is sent to Cube. It is NEVER evaluated by the trusted host. */
export function workflowGuestSource(input: {
  script: string;
  operationId: string;
  cwd: string;
}): string {
  return (
    `const input=${JSON.stringify(input)};\n` +
    String.raw`
const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const inputLines = readline.createInterface({ input: process.stdin });
const pending = new Map();
const children = new Map();
let sequence = 0;
const send = (frame) => process.stdout.write(JSON.stringify(frame) + '\n');
const call = (method, args) => new Promise((resolve, reject) => {
  const id = ++sequence;
  pending.set(id, { resolve, reject });
  send({ type: 'call', id, method, args });
});
inputLines.on('line', (line) => {
  const response = JSON.parse(line);
  const task = pending.get(response.id);
  if (!task) return;
  pending.delete(response.id);
  if (response.ok) task.resolve(response.value);
  else task.reject(new Error(response.error || 'Workflow request failed'));
});
inputLines.on('close', () => {
  for (const task of pending.values()) task.reject(new Error('Workflow host disconnected'));
});
const runs = Object.freeze({
  run(key, task) {
    if (typeof key !== 'string' || !key || !task || typeof task.task !== 'string')
      return Promise.reject(new Error('runs.run requires a key and {task,context?,sandbox?,cwd?,tools?}'));
    const spec = JSON.stringify({task:task.task,context:task.context||'fresh',sandbox:task.sandbox||'shared',cwd:task.cwd ?? null,tools:task.tools ? [...task.tools].sort() : null});
    const previous = children.get(key);
    if (previous) {
      if (previous.spec !== spec) return Promise.reject(new Error('Workflow key reused with different arguments'));
      return previous.promise;
    }
    const promise = call('run', { key, task }).then(result => {
      if (['failed','cancelled','unknown'].includes(result.state)) {
        const error = new Error(result.failureMessage || result.state); error.result = result; throw error;
      }
      return result;
    });
    promise.catch(() => {});
    children.set(key, { spec, promise });
    return promise;
  },
  all(tasks) { return Promise.all(tasks.map(({key, ...task}) => runs.run(key, task).catch(error => error.result || {state:'failed',error:String(error.message||error)}))); },
  status(target) { return call('status', {target}); },
  wait(target) { return call('wait', {target}); },
  cancel(target) { return call('cancel', {target}); },
  send(target, message, delivery = 'notify') { return call('send', {target, message, delivery}); },
});
const log = (...values) => send({ type: 'progress', value: values.map(String).join(' ').slice(0, 4096) });
const emit = (value) => send({type:'progress', value});
(async () => {
  process.stderr.write('PI_CLOUD_WORKFLOW_READY\n');
  const folder = path.join(input.cwd, 'workflows');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, input.operationId + '.js'), input.script);
  process.chdir(input.cwd);
  const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
  const value = await new AsyncFunction('runs', 'console', 'emit', input.script)(runs, {log,info:log,warn:log,error:log}, emit);
  if (pending.size) throw new Error('Workflow returned with unawaited child requests');
  send({type:'complete', ok:true, value: value === undefined ? null : value});
})().catch(error => send({type:'complete', ok:false, value:null, error:String(error.message || error)}))
  .finally(() => { inputLines.close(); process.stdout.end(() => process.exit(0)); });
`
  );
}
