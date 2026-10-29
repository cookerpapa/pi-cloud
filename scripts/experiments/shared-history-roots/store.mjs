// Isolated PG history experiment; intentionally not a complete Pi Storage adapter.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Directory, digest, emptyDigest, entryMetadataDigest } from "./directory.mjs";

const number = (n) => (n === null || n === undefined ? n : Number(n));
const rootRow = (r) =>
  r && { ...r, seq: number(r.seq), next_id: number(r.next_id), generation: number(r.generation) };
const MAX = Number.MAX_SAFE_INTEGER;
function streamRow(row) {
  assert(row, "Stream is missing");
  for (const key of ["start_id", "last_id", "records", "bytes", "head_id"])
    row[key] = number(row[key]);
  return row;
}

export class HistoryStore {
  constructor(pool, { directory = true, observe } = {}) {
    this.pool = pool;
    this.directory = directory;
    this.observe = observe;
  }
  async query(client, text, values = []) {
    const started = performance.now();
    const result = await client.query(text, values);
    this.observe?.({
      text,
      values,
      rows: result.rows,
      rowCount: result.rowCount,
      milliseconds: performance.now() - started,
    });
    return result;
  }
  async transaction(use, { signal, afterCommit } = {}) {
    const client = await this.pool.connect(),
      q = (text, values) => this.query(client, text, values);
    let committed = false;
    try {
      await q("begin");
      await q(
        "select set_config('lock_timeout','5s',true),set_config('statement_timeout','30s',true)",
      );
      signal?.throwIfAborted();
      const result = await use(q);
      signal?.throwIfAborted();
      await q("commit");
      committed = true;
      await afterCommit?.();
      return result;
    } catch (error) {
      if (!committed) await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  async view(q, tenant, id, lock = "for share") {
    assert(["for share", "for update", ""].includes(lock));
    const row = rootRow(
      (await q(`select * from lab_views where tenant=$1 and id=$2 ${lock}`, [tenant, id])).rows[0],
    );
    assert(row, "View is missing");
    return row;
  }
  async stream(q, id) {
    const row = (await q("select * from lab_streams where id=$1", [id])).rows[0];
    return streamRow(row);
  }
  async newStream(q, tenant, start = 2) {
    const id = randomUUID();
    await q(
      "insert into lab_streams(id,tenant,start_id,last_id,digest) values($1,$2,$3::bigint,$3::bigint-1,$4)",
      [id, tenant, start, emptyDigest],
    );
    return id;
  }
  create(tenant) {
    return this.transaction(async (q) => {
      const stream = await this.newStream(q, tenant),
        id = randomUUID();
      await q("insert into lab_views(id,tenant,stream) values($1,$2,$3)", [id, tenant, stream]);
      return { id, tenant, generation: 0, seq: 0, next_id: 2 };
    });
  }
  async append(tenant, id, batch, options = {}) {
    assert(batch.entries.length > 0 && batch.entries.length <= 256, "Append batch must be bounded");
    const fingerprint = digest(JSON.stringify(batch));
    return this.transaction(async (q) => {
      const view = await this.view(q, tenant, id, "for update");
      assert(!view.read_only, "Read comparison fixture cannot append");
      assert.equal(view.generation, batch.generation, "Stale append generation");
      if (batch.seq <= view.seq) {
        const prior = (
          await q("select digest from lab_receipts where view_id=$1 and seq=$2", [id, batch.seq])
        ).rows[0];
        assert.equal(
          prior?.digest,
          fingerprint,
          "Commit replay changed bytes or targets inherited history",
        );
        return false;
      }
      assert.equal(batch.seq, view.seq + 1, "Noncontiguous append");
      const stream = await this.stream(q, view.stream),
        rows = [];
      let last = stream.last_id,
        count = stream.records,
        bytes = stream.bytes,
        head = stream.head_id,
        prefix = stream.digest;
      for (const item of batch.entries) {
        const entry = item.entry ?? item;
        assert.equal(
          entry.conversationId,
          1,
          "Prototype supports a single logical Conversation only",
        );
        assert(
          Number.isSafeInteger(entry.id) && entry.id >= view.next_id && entry.id > last,
          "Prototype requires ascending native Entry IDs",
        );
        assert(
          entry.head === undefined || (Number.isSafeInteger(entry.head) && entry.head <= entry.id),
          "Invalid native head",
        );
        const body = JSON.stringify(entry),
          sha = digest(body),
          size = Buffer.byteLength(body),
          presentation = JSON.stringify(item.presentation ?? {});
        last = entry.id;
        count++;
        bytes += size;
        if (entry.head !== undefined) head = entry.id;
        const presentationSha = digest(presentation);
        if (this.directory) prefix = digest(prefix + sha + presentationSha);
        const metadata = {
          id: last,
          seq: batch.seq,
          body_sha: sha,
          body_bytes: size,
          presentation_sha: presentationSha,
          head: entry.head ?? null,
          prefix_records: this.directory ? count : null,
          prefix_bytes: this.directory ? bytes : null,
          prefix_head: this.directory ? head : null,
          prefix_digest: this.directory ? prefix : null,
        };
        rows.push({
          id: last,
          body,
          sha,
          size,
          presentation,
          presentationSha,
          metadataSha: entryMetadataDigest(metadata),
          head: entry.head ?? null,
          count,
          bytes,
          prefix,
          latest: head,
          assets: [...new Set(item.assets ?? [])],
        });
      }
      const columns =
        "stream,id,seq,body,body_sha,body_bytes,presentation,presentation_sha,metadata_sha,head,prefix_records,prefix_bytes,prefix_head,prefix_digest";
      const params = [],
        values = rows.map(
          (r) =>
            "(" +
            [
              view.stream,
              r.id,
              batch.seq,
              r.body,
              r.sha,
              r.size,
              r.presentation,
              r.presentationSha,
              r.metadataSha,
              r.head,
              this.directory ? r.count : null,
              this.directory ? r.bytes : null,
              this.directory ? r.latest : null,
              this.directory ? r.prefix : null,
            ]
              .map((v) => {
                params.push(v);
                return "$" + params.length;
              })
              .join(",") +
            ")",
        );
      await q(`insert into lab_entries(${columns}) values ${values.join(",")}`, params);
      const refs = rows.flatMap((r) => r.assets.map((asset) => ({ entry: r.id, asset })));
      if (refs.length) {
        const inventory = (
          await q("select id from lab_assets where tenant=$1 and id=any($2::uuid[]) for share", [
            tenant,
            refs.map((r) => r.asset),
          ])
        ).rows;
        const ready = new Set(inventory.map((r) => r.id));
        assert(
          refs.every((r) => ready.has(r.asset)),
          "Image asset is unavailable",
        );
        const parameters = [],
          tuples = refs.map(
            (r) =>
              "(" +
              [view.stream, r.entry, r.asset]
                .map((v) => {
                  parameters.push(v);
                  return "$" + parameters.length;
                })
                .join(",") +
              ")",
          );
        await q(
          `insert into lab_entry_assets(stream,entry_id,asset) values ${tuples.join(",")}`,
          parameters,
        );
      }
      await q(
        `update lab_streams set last_id=$2,records=$3,bytes=$4,head_id=$5,digest=$6 where id=$1`,
        [view.stream, last, count, bytes, head, prefix],
      );
      await q("insert into lab_receipts(view_id,seq,digest) values($1,$2,$3)", [
        id,
        batch.seq,
        fingerprint,
      ]);
      await q("update lab_views set seq=$2,next_id=$3 where id=$1", [id, batch.seq, last + 1]);
      await options.beforeCommit?.();
      return true;
    }, options);
  }
  async ownLeaf(q, dir, view, at = MAX) {
    const stream = await this.stream(q, view.stream);
    if (!stream.records || at < stream.start_id) return undefined;
    return dir.leaf(stream, Math.min(at, stream.last_id));
  }
  async snapshot(q, dir, view) {
    return dir.join(await dir.get(view.base), await this.ownLeaf(q, dir, view));
  }
  async prefix(q, dir, view, at) {
    const base = await dir.get(view.base);
    if (base && at <= base.max_id) {
      const leaf = await dir.locate(base, at);
      assert(leaf, "Fork point is outside history");
      const found = (
        await q("select id from lab_entries where stream=$1 and id=$2 and seq<=$3", [
          leaf.stream,
          at,
          leaf.through_seq,
        ])
      ).rows[0];
      assert(found, "Fork point is missing");
      return dir.prefix(base, at);
    }
    const own = await this.ownLeaf(q, dir, view, at);
    assert(own && own.max_id === at, "Fork point is outside history");
    return dir.join(base, own);
  }
  async fork(tenant, source, at, key, options = {}) {
    assert(this.directory, "Flat comparison store has no shared directory");
    const replay = async (q) => {
      const prior = rootRow(
        (await q("select * from lab_views where tenant=$1 and request_key=$2", [tenant, key]))
          .rows[0],
      );
      if (prior)
        assert(
          prior.request_source === source && Number(prior.request_at) === at,
          "Fork idempotency key changed request",
        );
      return prior;
    };
    try {
      return await this.transaction(async (q) => {
        const prior = await replay(q);
        if (prior) return prior;
        const view = await this.view(q, tenant, source),
          dir = new Directory(q, tenant);
        const root = await this.prefix(q, dir, view, at),
          base = await dir.persist(root);
        const stream = await this.newStream(q, tenant, view.next_id),
          id = randomUUID();
        const row = rootRow(
          (
            await q(
              `insert into lab_views(id,tenant,base,stream,seq,next_id,request_key,request_source,request_at)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
              [id, tenant, base, stream, view.seq, view.next_id, key, source, at],
            )
          ).rows[0],
        );
        await options.beforeCommit?.();
        return row;
      }, options);
    } catch (error) {
      // A concurrent successful request may win the unique key. A lost COMMIT
      // reply is deliberately not auto-retried; the caller retries its same key.
      if (error.code !== "23505") throw error;
      const prior = await replay((t, v) => this.query(this.pool, t, v));
      if (prior) return prior;
      throw error;
    }
  }
  async prune(tenant, id, at) {
    return this.transaction(async (q) => {
      const view = await this.view(q, tenant, id, "for update"),
        dir = new Directory(q, tenant);
      assert(!view.read_only, "Read comparison fixture cannot prune");
      const base = await dir.persist(await this.prefix(q, dir, view, at));
      const stream = await this.newStream(q, tenant, view.next_id);
      return rootRow(
        (
          await q(
            `update lab_views set base=$2,stream=$3,generation=generation+1 where id=$1 returning *`,
            [id, base, stream],
          )
        ).rows[0],
      );
    });
  }
  remove(tenant, id) {
    return this.transaction((q) =>
      q("delete from lab_views where tenant=$1 and id=$2", [tenant, id]),
    );
  }
  async pin(tenant, id) {
    return this.transaction(async (q) => {
      const view = await this.view(q, tenant, id),
        dir = new Directory(q, tenant);
      const root = await dir.persist(await this.snapshot(q, dir, view));
      assert(root, "Cannot pin an empty history");
      const pin = randomUUID();
      await q("insert into lab_pins(id,tenant,root) values($1,$2,$3)", [pin, tenant, root]);
      return pin;
    });
  }
  unpin(tenant, id) {
    return this.transaction((q) =>
      q("delete from lab_pins where tenant=$1 and id=$2", [tenant, id]),
    );
  }
  async readScope(q, tenant, id, options) {
    const dir = new Directory(q, tenant);
    if (options.pin) {
      const row = (
        await q(
          "select n.* from lab_pins p join lab_nodes n on n.id=p.root and n.tenant=p.tenant where p.id=$1 and p.tenant=$2 for share of p",
          [options.pin, tenant],
        )
      ).rows[0];
      assert(row, "Read pin is missing");
      return { dir, root: dir.accept(row), view: undefined };
    }
    const row = (
      await q(
        `select v.*,to_json(s) as captured_stream,to_json(n) as captured_base
      from lab_views v join lab_streams s on s.id=v.stream and s.tenant=v.tenant
      left join lab_nodes n on n.id=v.base and n.tenant=v.tenant
      where v.tenant=$1 and v.id=$2 for share of v`,
        [tenant, id],
      )
    ).rows[0];
    assert(row, "View is missing");
    const view = rootRow(row),
      capturedStream = streamRow(row.captured_stream);
    if (options.cursor)
      assert.equal(options.cursor.generation, view.generation, "Stale history cursor");
    return {
      dir,
      root: view.base ? dir.accept(row.captured_base) : undefined,
      view,
      capturedStream,
    };
  }
  async ranges(q, scope, minimum, maximum, limit) {
    const { dir, root, view } = scope,
      ranges = [];
    if (view) {
      const stream = scope.capturedStream;
      if (stream.records && stream.last_id >= minimum && stream.start_id <= maximum) {
        ranges.push({
          stream: stream.id,
          through_id: stream.last_id,
          through_seq: view.seq,
          min_id: stream.start_id,
          max_id: stream.last_id,
          own: true,
        });
        if (maximum >= stream.last_id && minimum <= stream.start_id && stream.records >= limit)
          return ranges;
      }
    }
    if (ranges.length < limit)
      ranges.push(...(await dir.leaves(root, minimum, maximum, limit - ranges.length)));
    return ranges;
  }
  decode(row) {
    assert.equal(entryMetadataDigest(row), row.metadata_sha, "History metadata integrity failed");
    assert.equal(digest(row.body), row.body_sha, "History body integrity failed");
    assert.equal(
      digest(row.presentation),
      row.presentation_sha,
      "History presentation integrity failed",
    );
    const entry = JSON.parse(row.body);
    assert.equal(entry.id, Number(row.id), "History entry identity changed");
    if (!row.own) delete entry.byTaskId;
    return { entry, commitSeq: Number(row.seq), presentation: JSON.parse(row.presentation) };
  }
  async readRanges(q, ranges, minimum, maximum, limit, headOnly = false) {
    if (!ranges.length) return [];
    const params = [],
      tuples = ranges.map(
        (r) =>
          "(" +
          [r.stream, r.through_id, r.through_seq, !!r.own]
            .map((v, i) => {
              params.push(v);
              return "$" + params.length + ["::uuid", "::bigint", "::bigint", "::boolean"][i];
            })
            .join(",") +
          ")",
      );
    params.push(minimum, maximum, limit);
    const n = params.length;
    const rows = (
      await q(
        `with ranges(stream,through_id,through_seq,own) as(values ${tuples.join(",")})
      select e.*,ranges.own from ranges cross join lateral (
        select * from lab_entries e where e.stream=ranges.stream and e.id<=ranges.through_id and e.seq<=ranges.through_seq
          and e.id>=$${n - 2} and e.id<=$${n - 1} ${headOnly ? "and e.head is not null" : ""}
        order by e.id desc limit $${n}
      ) e order by e.id desc limit $${n}`,
        params,
      )
    ).rows;
    return rows.map((r) => this.decode(r));
  }
  page(tenant, id, options = {}) {
    return this.transaction(async (q) => {
      const minimum = options.min ?? 0,
        maximum = Math.min(options.max ?? MAX, (options.cursor?.after ?? MAX + 1) - 1);
      const limit = options.limit ?? 32;
      assert(limit > 0 && limit <= 256, "Page size must be bounded");
      const scope = await this.readScope(q, tenant, id, options);
      const ranges = await this.ranges(q, scope, minimum, maximum, limit + 1);
      const rows = await this.readRanges(q, ranges, minimum, maximum, limit + 1);
      return {
        items: rows.slice(0, limit),
        ...(rows.length > limit
          ? { next: { after: rows[limit - 1].entry.id, generation: scope.view?.generation ?? 0 } }
          : {}),
      };
    });
  }
  entry(tenant, id, entryId, options = {}) {
    return this.transaction(async (q) => {
      const scope = await this.readScope(q, tenant, id, options),
        ranges = await this.ranges(q, scope, entryId, entryId, 1);
      return (await this.readRanges(q, ranges, entryId, entryId, 1))[0];
    });
  }
  latestHead(tenant, id, at = MAX, options = {}) {
    return this.transaction(async (q) => {
      const scope = await this.readScope(q, tenant, id, options);
      if (scope.view) {
        const stream = scope.capturedStream;
        if (stream.head_id !== null && at >= stream.start_id) {
          const rows = await this.readRanges(
            q,
            [
              {
                stream: stream.id,
                through_id: stream.last_id,
                through_seq: scope.view.seq,
                own: true,
              },
            ],
            0,
            at,
            1,
            true,
          );
          if (rows.length) return rows[0].entry;
        }
      }
      const find = async (node) => {
        if (!node || node.head_id === null || node.min_id > at) return undefined;
        if (node.stream) return (await this.readRanges(q, [node], 0, at, 1, true))[0]?.entry;
        return (
          (await find(await scope.dir.get(node.right_id))) ??
          (await find(await scope.dir.get(node.left_id)))
        );
      };
      return find(scope.root);
    });
  }
  async asset(tenant, id, assetId) {
    return this.transaction(async (q) => {
      const scope = await this.readScope(q, tenant, id, {});
      const refs = (
        await q(
          `select a.stream,a.entry_id from lab_entry_assets a join lab_assets b on b.id=a.asset
        where b.tenant=$1 and a.asset=$2 order by a.entry_id`,
          [tenant, assetId],
        )
      ).rows;
      for (const ref of refs) {
        const entryId = Number(ref.entry_id),
          ranges = await this.ranges(q, scope, entryId, entryId, 1);
        if (ranges.some((r) => r.stream === ref.stream && entryId <= r.through_id))
          return (
            await q("select bytes from lab_assets where id=$1 and tenant=$2", [assetId, tenant])
          ).rows[0].bytes;
      }
      throw Error("Image asset is outside this view");
    });
  }
  // Metadata-based collection. Unreachable directory nodes are removed before
  // trimming stream suffixes. A pin and a view use the same FK protection.
  async collect(tenant, limit = 64) {
    return this.transaction(async (q) => {
      const deletedNodes = (
        await q(
          `with candidates as (
        select n.id from lab_nodes n where n.tenant=$1
          and not exists(select 1 from lab_views v where v.base=n.id)
          and not exists(select 1 from lab_pins p where p.root=n.id)
          and not exists(select 1 from lab_nodes p where p.left_id=n.id or p.right_id=n.id)
        order by n.id for update skip locked limit $2
      ) delete from lab_nodes n using candidates c where n.id=c.id returning n.id`,
          [tenant, limit],
        )
      ).rowCount;
      const streams = (
        await q(
          `select s.id from lab_streams s where s.tenant=$1
        and not exists(select 1 from lab_views v where v.stream=s.id)
        and (exists(select 1 from lab_entries e where e.stream=s.id
              and e.id>coalesce((select max(through_id) from lab_nodes where stream=s.id),0))
          or (not exists(select 1 from lab_entries e where e.stream=s.id)
              and not exists(select 1 from lab_nodes n where n.stream=s.id)))
        order by s.id for update of s skip locked limit 8`,
          [tenant],
        )
      ).rows;
      let records = 0,
        bytes = 0;
      for (const { id } of streams) {
        if (records >= limit) break;
        const bound = (
          await q(
            `select exists(select 1 from lab_views where stream=$1) as owned,
          coalesce((select max(through_id) from lab_nodes where stream=$1),0)::text as retained`,
            [id],
          )
        ).rows[0];
        if (bound.owned) continue;
        const deleted = (
          await q(
            `with doomed as(select id from lab_entries where stream=$1 and id>$2 order by id desc limit $3)
          delete from lab_entries e using doomed d where e.stream=$1 and e.id=d.id returning e.body_bytes`,
            [id, bound.retained, limit - records],
          )
        ).rows;
        records += deleted.length;
        bytes += deleted.reduce((sum, r) => sum + r.body_bytes, 0);
        await q(
          `delete from lab_streams s where s.id=$1 and not exists(select 1 from lab_entries e where e.stream=s.id)
          and not exists(select 1 from lab_nodes n where n.stream=s.id) and not exists(select 1 from lab_views v where v.stream=s.id)`,
          [id],
        );
      }
      const assets = (
        await q(
          `with doomed as(select a.id from lab_assets a where a.tenant=$1
        and not exists(select 1 from lab_entry_assets r where r.asset=a.id)
        and not exists(select 1 from lab_asset_pins p where p.asset=a.id)
        order by a.id for update skip locked limit $2)
        delete from lab_assets a using doomed d where a.id=d.id returning a.id`,
          [tenant, limit],
        )
      ).rowCount;
      return { nodes: deletedNodes, records, bytes, assets };
    });
  }
}
