// Persistent AVL directory of immutable stream prefixes. No data bodies here.
import { createHash, randomUUID } from "node:crypto";
import assert from "node:assert/strict";

export const digest = (value) => createHash("sha256").update(value).digest("hex");
export const emptyDigest = digest("");
export const entryMetadataDigest = (row) =>
  digest(
    JSON.stringify([
      Number(row.id),
      Number(row.seq),
      row.body_sha,
      Number(row.body_bytes),
      row.presentation_sha,
      ...["head", "prefix_records", "prefix_bytes", "prefix_head"].map((k) =>
        row[k] === null ? null : Number(row[k]),
      ),
      row.prefix_digest,
    ]),
  );
const fields = [
  "left_id",
  "right_id",
  "stream",
  "through_id",
  "through_seq",
  "min_id",
  "max_id",
  "height",
  "records",
  "bytes",
  "head_id",
  "prefix_digest",
];
export function normalize(row) {
  if (!row) return row;
  const value = { ...row };
  for (const key of [
    "through_id",
    "through_seq",
    "min_id",
    "max_id",
    "height",
    "records",
    "bytes",
    "head_id",
  ])
    if (value[key] !== null && value[key] !== undefined) value[key] = Number(value[key]);
  return value;
}
export const nodeDigest = (node) => digest(JSON.stringify(fields.map((key) => node[key] ?? null)));

export class Directory {
  constructor(query, tenant) {
    this.query = query;
    this.tenant = tenant;
    this.cache = new Map();
    this.created = new Map();
  }
  async get(id) {
    if (!id) return undefined;
    if (this.cache.has(id)) return this.cache.get(id);
    const row = normalize(
      (await this.query("select * from lab_nodes where id=$1 and tenant=$2", [id, this.tenant]))
        .rows[0],
    );
    return this.accept(row);
  }
  accept(input) {
    const row = normalize(input);
    assert(row, "History directory node is missing");
    assert.equal(row.tenant, this.tenant, "History directory tenant changed");
    assert.equal(nodeDigest(row), row.digest, "History directory integrity failed");
    this.cache.set(row.id, row);
    return row;
  }
  make(input) {
    const node = {
      id: randomUUID(),
      tenant: this.tenant,
      ...Object.fromEntries(fields.map((k) => [k, null])),
      ...input,
    };
    node.digest = nodeDigest(node);
    this.cache.set(node.id, node);
    this.created.set(node.id, node);
    return node;
  }
  async leaf(stream, at) {
    const row = (
      await this.query(
        `select id,seq,body_sha,body_bytes,presentation_sha,metadata_sha,head,prefix_records,prefix_bytes,prefix_head,prefix_digest
      from lab_entries where stream=$1 and id=$2`,
        [stream.id, at],
      )
    ).rows[0];
    assert(row?.prefix_digest, "Prefix metadata is unavailable");
    assert.equal(entryMetadataDigest(row), row.metadata_sha, "Prefix metadata integrity failed");
    return this.make({
      stream: stream.id,
      through_id: Number(row.id),
      through_seq: Number(row.seq),
      min_id: Number(stream.start_id),
      max_id: Number(row.id),
      height: 1,
      records: Number(row.prefix_records),
      bytes: Number(row.prefix_bytes),
      head_id: row.prefix_head === null ? null : Number(row.prefix_head),
      prefix_digest: row.prefix_digest,
    });
  }
  pair(a, b) {
    if (!a) return b;
    if (!b) return a;
    assert(a.max_id < b.min_id, "Directory ranges overlap");
    return this.make({
      left_id: a.id,
      right_id: b.id,
      min_id: a.min_id,
      max_id: b.max_id,
      height: Math.max(a.height, b.height) + 1,
      records: a.records + b.records,
      bytes: a.bytes + b.bytes,
      head_id: b.head_id ?? a.head_id,
      // Bind child content digests as well as identity. The field also covers leaves' prefix digests.
      prefix_digest: digest(a.digest + b.digest),
    });
  }
  async balance(a, b) {
    if (!a || !b) return a ?? b;
    if (a.height > b.height + 1) {
      const l = await this.get(a.left_id),
        r = await this.get(a.right_id);
      if (l.height >= r.height) return this.pair(l, this.pair(r, b));
      return this.pair(
        this.pair(l, await this.get(r.left_id)),
        this.pair(await this.get(r.right_id), b),
      );
    }
    if (b.height > a.height + 1) {
      const l = await this.get(b.left_id),
        r = await this.get(b.right_id);
      if (r.height >= l.height) return this.pair(this.pair(a, l), r);
      return this.pair(
        this.pair(a, await this.get(l.left_id)),
        this.pair(await this.get(l.right_id), r),
      );
    }
    return this.pair(a, b);
  }
  async join(a, b) {
    if (!a || !b) return a ?? b;
    if (a.height > b.height + 1)
      return this.balance(
        await this.get(a.left_id),
        await this.join(await this.get(a.right_id), b),
      );
    if (b.height > a.height + 1)
      return this.balance(
        await this.join(a, await this.get(b.left_id)),
        await this.get(b.right_id),
      );
    return this.pair(a, b);
  }
  async prefix(node, at) {
    if (!node || at < node.min_id) return undefined;
    if (node.max_id <= at) return node;
    if (node.stream) return this.leaf({ id: node.stream, start_id: node.min_id }, at);
    const left = await this.get(node.left_id);
    if (at <= left.max_id) return this.prefix(left, at);
    return this.join(left, await this.prefix(await this.get(node.right_id), at));
  }
  async locate(node, at) {
    while (node) {
      if (at < node.min_id || at > node.max_id) return undefined;
      if (node.stream) return node;
      const left = await this.get(node.left_id);
      node = await this.get(at <= left.max_id ? node.left_id : node.right_id);
    }
    return undefined;
  }
  async leaves(node, minimum, maximum, limit = 256) {
    if (!node || node.max_id < minimum || node.min_id > maximum) return [];
    if (node.stream) return [node];
    // First locate the upper rank, then visit only subtrees overlapping a page.
    // One recursive SQL statement replaces per-node network round trips.
    let upper = node.records;
    if (maximum < node.max_id) {
      const path = (
        await this.query(
          `with recursive path as (
        select n.*,0::bigint as preceding from lab_nodes n where n.id=$1
        union all
        select c.*,p.preceding+case when c.id=p.right_id then l.records else 0 end
        from path p join lab_nodes l on l.id=p.left_id
        join lab_nodes c on c.id=case when $2<=l.max_id then p.left_id else p.right_id end
      ) select p.*,p.preceding+coalesce(e.prefix_records,0) as upper_rank,to_json(e) as boundary
        from path p left join lateral (
          select id,seq,body_sha,body_bytes,presentation_sha,metadata_sha,head,
            prefix_records,prefix_bytes,prefix_head,prefix_digest from lab_entries where stream=p.stream and id<=least($2,p.through_id)
            and seq<=p.through_seq order by id desc limit 1
        ) e on true`,
          [node.id, maximum],
        )
      ).rows.map(normalize);
      for (const p of path)
        assert.equal(nodeDigest(p), p.digest, "History directory integrity failed");
      for (const p of path)
        if (p.boundary)
          assert.equal(
            entryMetadataDigest(p.boundary),
            p.boundary.metadata_sha,
            "Cursor boundary integrity failed",
          );
      upper = Number(path.find((p) => p.stream)?.upper_rank ?? 0);
    }
    const lower = Math.max(0, upper - limit);
    const visited = (
      await this.query(
        `with recursive walk as (
      select n.*,0::bigint as preceding from lab_nodes n where n.id=$1
      union all
      select c.*,v.preceding from walk p join lab_nodes l on l.id=p.left_id
      cross join lateral(values(p.left_id,p.preceding),(p.right_id,p.preceding+l.records)) v(id,preceding)
      join lab_nodes c on c.id=v.id
      where v.preceding<$3 and v.preceding+c.records>$2 and c.min_id<=$5 and c.max_id>=$4
    ) select * from walk`,
        [node.id, lower, upper, minimum, maximum],
      )
    ).rows.map(normalize);
    for (const n of visited) {
      assert.equal(nodeDigest(n), n.digest, "History directory integrity failed");
      this.cache.set(n.id, n);
    }
    return visited
      .filter((n) => n.stream && n.min_id <= maximum && n.max_id >= minimum)
      .sort((a, b) => b.max_id - a.max_id);
  }
  async persist(root) {
    if (!root) return null;
    const pending = [];
    const visit = (id) => {
      const n = this.created.get(id);
      if (!n) return;
      this.created.delete(id);
      visit(n.left_id);
      visit(n.right_id);
      pending.push(n);
    };
    visit(root.id);
    if (pending.length) {
      const columns = ["id", "tenant", ...fields, "digest"],
        params = [];
      const values = pending.map(
        (n) =>
          "(" +
          columns
            .map((k) => {
              params.push(n[k]);
              return "$" + params.length;
            })
            .join(",") +
          ")",
      );
      await this.query(
        `insert into lab_nodes(${columns.join(",")}) values ${values.join(",")}`,
        params,
      );
    }
    return root.id;
  }
}
