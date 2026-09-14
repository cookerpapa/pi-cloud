# Subagents

PiCloud provides one role-free `subagent` tool. The Agent may delegate a task
directly or submit a JavaScript workflow. Users can request either in ordinary
language; they do not configure Workers or Kafka.

## Direct task

```js
subagent({ action: "run", task: "Check the collision logic", context: "branch", workspace: "shared" })
```

`fresh` starts from the task. `branch` inherits the frozen history before the
current parent prompt, not intermediate reasoning or Tool results produced
during that Run; pass any such findings explicitly in the child task.
`shared` uses the parent environment; `isolated` prepares a separate Workspace
copy. Optional `tools` narrows file/shell permissions; `[]` disables those tools,
not hosted search or delegation. Direct tasks do not allocate Cube unless an
actual local operation or an explicit Workspace copy needs it.

## Workflow

```js
subagent({ action: "workflow", script: `
  const results = await runs.all([
    { key: "ui", task: "Review interaction errors", context: "branch" },
    { key: "api", task: "Review API validation", context: "fresh" }
  ]);
  return results.map(result => result.output);
` })
```

Scripts execute with the Bash capability inside Cube and are saved under
`workflows/<operation-id>.js` in their Workspace. `runs.run(key, task)` waits for
one child; `runs.all(tasks)` retains input order and returns individual failure
results. A failed single child rejects its script call. Every launch must be
awaited; conflicting reuse of a key fails. `console`/`emit` are progress, not the
return value, and do not create model messages.

The API also offers `runs.status`, `runs.wait`, `runs.cancel` and
`runs.send(target, message, delivery)`. A target is a returned execution ID or
workflow key. `notify` does not wake a closed Agent; `steer` is received at a safe
model boundary, and `follow_up` queues work in an active Agent. Finished tasks
report `missed`; background resurrection is not implied. Blocking requests for
parent decisions use `contact_supervisor` and `subagent_supervisor`, also through
the control log.

## Cloud contract

Requests go through the owning Worker's existing Kafka publication. One
Projector orders admission/control, PostgreSQL retains dispatch/result and
consumption state, and the Worker Session Host owns all active Lanes and native
sequence allocation. Ordinary child output uses the same native log as parent
output. Internal notifications never use the public model egress proxy.

A family occupies one Worker slot and one owner lease. Child Runs keep task
identities, not independently renewed leases. Quiet tasks are managed by task/
model/Tool deadlines. Actual model requests (including Compaction) take a fair
permit and release it before waiting for children or Tools. Cancelling one task
does not revoke the common owner; losing the owner retires the whole family.

Duplicate delivery cannot create another child or duplicate a consumed Agent
message. Lost notifications are redelivered from persisted state. Seals and
native Tool completion retire unfinished owned work, except an explicit
supervisor handoff that remains owned by the parent Run. Already-issued guest
effects may be UNKNOWN. There is no automatic script replay or JS-memory resume.
Workspace copies are ordinary copies, not atomic snapshots of running programs.

See [ADR-0166](adr/0166-log-driven-subagents.md) and [configuration](CONFIGURATION.md).
