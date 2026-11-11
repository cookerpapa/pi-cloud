import { expect, it } from "vitest";
import { assertUncollectedComputeClosed } from "./source-delivery-observation.mjs";

const closed = {
  sourceId: "boxlite:owned-domain",
  cubeSourceId: "cubesandbox:owned-domain",
  workspacePurged: true,
  collectorExists: false,
};

it("retires only closed unpriced BoxLite test registrations with no receipt producer", () => {
  expect(() => assertUncollectedComputeClosed(closed)).not.toThrow();
  expect(() => assertUncollectedComputeClosed({ ...closed, workspacePurged: false })).toThrow(
    "unconfirmed Workspace closure",
  );
  expect(() => assertUncollectedComputeClosed({ ...closed, collectorExists: true })).toThrow(
    "delivery inventory",
  );
  expect(() =>
    assertUncollectedComputeClosed({ ...closed, sourceId: "unknown:owned-domain" }),
  ).toThrow("Unknown compute receipt producer");
});
