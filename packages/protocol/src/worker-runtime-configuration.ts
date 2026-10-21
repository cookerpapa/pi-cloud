import { Type, type Static } from "typebox";

/** Policy only: enabled egress does not prove that an upstream is reachable. */
export const GuestPublicEgressSchema = Type.Object(
  {
    revision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    status: Type.Union([
      Type.Literal("enabled"),
      Type.Literal("disabled"),
      Type.Literal("unknown"),
    ]),
  },
  { additionalProperties: false },
);
export type GuestPublicEgress = Static<typeof GuestPublicEgressSchema>;

export const WorkerRuntimeConfigurationSchema = Type.Object(
  { publicEgress: GuestPublicEgressSchema },
  { additionalProperties: false },
);
export type WorkerRuntimeConfiguration = Static<typeof WorkerRuntimeConfigurationSchema>;
