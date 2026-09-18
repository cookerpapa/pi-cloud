import { Value } from "typebox/value";
import type { TSchema } from "typebox";

// Browser CSP forbids code generation; select this at bundle time, not by trying eval.
export function createSchemaCheck(schema: TSchema): (value: unknown) => boolean {
  return (value) => Value.Check(schema, value);
}
