import { expect, it } from "vitest";
import { assertUncollectedComputeClosed } from "./source-delivery-observation.mjs";

const closed = {
  sourceId: "boxlite:owned-domain",
  registeredBoxliteBackend: true,
  workspacePurged: true,
  collectorExists: false,
};

it("retires only closed unpriced BoxLite test registrations with no receipt producer", () => {
  expect(() => assertUncollectedComputeClosed(closed)).not.toThrow();
  expect(() =>
    assertUncollectedComputeClosed({ ...closed, sourceId: "boxlite:independent-cluster" }),
  ).not.toThrow();
  expect(() =>
    assertUncollectedComputeClosed({ ...closed, registeredBoxliteBackend: false }),
  ).toThrow("Unknown compute receipt producer");
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
