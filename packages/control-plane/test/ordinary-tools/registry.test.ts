import { expect, it } from "vitest";
import type { Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
import { ImageAttachmentCodec, PostgresImageAttachmentStore } from "@pi-cloud/session-attachments";
import type { ImageBlobStore } from "@pi-cloud/session-attachments";
import { createOrdinaryToolRegistry } from "../../src/ordinary-tools/registry.ts";

it("advertises only configured executable tools and preserves explicit enablement", () => {
  const database = {} as Kysely<Database>;
  const store = new PostgresImageAttachmentStore(database, {} as ImageBlobStore);
  const options = {
    database,
    imageIo: async () => {
      throw new Error("No file operation during registration");
    },
    refreshServices: async () => {
      throw new Error("No VM operation during registration");
    },
  };
  expect(
    createOrdinaryToolRegistry(options)
      .read()
      .tools.map((t) => t.name),
  ).toEqual(["preview", "schedule"]);
  const images = {
    store,
    codec: new ImageAttachmentCodec(store),
    blobs: store.blobs,
  } as Parameters<typeof createOrdinaryToolRegistry>[0]["images"];
  expect(
    createOrdinaryToolRegistry({ ...options, images: images! })
      .read()
      .tools.map((t) => t.name),
  ).toEqual(["preview", "schedule", "show_image"]);
  expect(
    createOrdinaryToolRegistry({ ...options, images: images!, enabled: [] }).read().tools,
  ).toEqual([]);
  expect(() => createOrdinaryToolRegistry({ ...options, enabled: ["missing_tool"] })).toThrow(
    "not registered",
  );
});
