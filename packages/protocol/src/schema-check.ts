import { Compile } from "typebox/compile";
import type { TSchema } from "typebox";

export function createSchemaCheck(schema: TSchema): (value: unknown) => boolean {
  const validator = Compile(schema);
  return (value) => validator.Check(value);
}
