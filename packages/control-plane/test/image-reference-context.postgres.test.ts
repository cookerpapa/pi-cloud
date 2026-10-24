import { expect, it } from "vitest";
import { sql } from "kysely";
import { nativeSubagentFixture } from "./native-subagent-fixture.ts";
import { recentConversationImages } from "../src/control-image-tool.ts";
import { SessionImageReader } from "../src/session-image-reader.ts";

it("selects images at the issuing context boundary, excludes other lanes/new input, and authorizes retained assets", async () => {
  const f = await nativeSubagentFixture();
  try {
    const image = async () => {
      const ref = {
        id: crypto.randomUUID(),
        sha256: "a".repeat(64),
        byteLength: 1,
        mimeType: "image/png" as const,
      };
      await sql`insert into session_image_objects(tenant_id,id,source_run_id,state,sha256,byte_length,mime_type,write_completed_at)
        values(${f.scope.tenantId}::uuid,${ref.id}::uuid,${f.scope.runId}::uuid,'ready',${ref.sha256},1,'image/png',clock_timestamp())`.execute(
        f.database,
      );
      return ref;
    };
    const first = await image(),
      other = await image(),
      newer = await image();
    const entry = async (conversationId: number, ref: typeof first, head?: number) => {
      const id = f.allocateId();
      await f.append([
        {
          type: "entry",
          value: {
            id,
            conversationId,
            kind: "pi.user",
            version: 1,
            data: {},
            ...(head === undefined ? {} : { head }),
            model: [
              {
                role: "user",
                content: [{ type: "pi_cloud_image_v1", attachment: ref }],
                timestamp: Date.now(),
              },
            ],
          },
        },
      ]);
      return id;
    };
    const at = await entry(1, first);
    const child = f.allocateId();
    await f.append([{ type: "conversation", value: { id: child } }]);
    await entry(child, other);
    await entry(1, newer);
    const command = {
      ...(await f.command({ prompt: "reference" }, undefined, "generate_image")),
      invocationEntryId: at,
    };
    expect(
      await recentConversationImages(f.database, command, 1, new AbortController().signal),
    ).toEqual([first]);
    await expect(
      recentConversationImages(f.database, command, 2, new AbortController().signal),
    ).rejects.toThrow("only 1");
    const reader = new SessionImageReader(f.database, {
      async withStream(_tenant, ref, consume, signal) {
        expect(ref).toEqual(first);
        return consume(
          (async function* () {
            yield Buffer.from("x");
          })(),
          signal!,
        );
      },
    });
    expect(
      await reader.withImage(
        f.scope.tenantId,
        f.scope.sessionId,
        first.id,
        async (ref) => ref.id,
        new AbortController().signal,
      ),
    ).toBe(first.id);
    await expect(
      reader.withImage(
        crypto.randomUUID(),
        f.scope.sessionId,
        first.id,
        async () => null,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    const unretained = await image();
    await expect(
      reader.withImage(
        f.scope.tenantId,
        f.scope.sessionId,
        unretained.id,
        async () => null,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    const cut = f.allocateId();
    await f.append([
      {
        type: "entry",
        value: {
          id: cut,
          conversationId: 1,
          kind: "pi.compaction",
          version: 1,
          data: {},
          head: cut,
          model: [{ role: "user", content: "Compacted context", timestamp: Date.now() }],
        },
      },
    ]);
    await expect(
      recentConversationImages(
        f.database,
        { ...command, invocationEntryId: cut },
        1,
        new AbortController().signal,
      ),
    ).rejects.toThrow("only 0");
  } finally {
    await f.close();
  }
}, 60_000);
