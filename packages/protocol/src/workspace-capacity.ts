import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const DEFAULT_WORKSPACE_CAPACITY_GIB = 32;
export const WorkspaceCapacityGiBSchema = Type.Integer({
  minimum: 1,
  maximum: Math.floor(Number.MAX_SAFE_INTEGER / 1024 ** 3),
});
export const WorkspaceCapacityChangeSchema = Type.Object(
  { minimumGiB: WorkspaceCapacityGiBSchema },
  { additionalProperties: false },
);
export type WorkspaceCapacityChange = Static<typeof WorkspaceCapacityChangeSchema>;
export type WorkspaceCapacitySnapshot = {
  workspaceId: string;
  capacityBytes: number;
  revision: number;
  pending: boolean;
};
export function parseWorkspaceCapacityChange(value: unknown): WorkspaceCapacityChange {
  if (!Value.Check(WorkspaceCapacityChangeSchema, value))
    throw new TypeError("Invalid Workspace capacity");
  return value;
}
export function workspaceCapacityBytes(gib: number): number {
  if (!Value.Check(WorkspaceCapacityGiBSchema, gib))
    throw new TypeError("Invalid Workspace capacity");
  return gib * 1024 ** 3;
}
