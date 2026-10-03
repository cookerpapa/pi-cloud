/** Position in the one ordered Session log, not another execution lease. */
export type ExecutionLogPosition = Readonly<{
  topic: string;
  partition: number;
  offset: string;
}>;

export function parseExecutionLogPosition(value: unknown): ExecutionLogPosition {
  const source = value as ExecutionLogPosition | undefined;
  if (
    !source ||
    typeof source.topic !== "string" ||
    !/^[A-Za-z0-9._-]{1,249}$/.test(source.topic) ||
    !Number.isSafeInteger(source.partition) ||
    source.partition < 0 ||
    source.partition > 65535 ||
    typeof source.offset !== "string" ||
    !/^(0|[1-9][0-9]{0,18})$/.test(source.offset) ||
    BigInt(source.offset) > 9223372036854775807n ||
    Object.keys(source).length !== 3
  )
    throw new Error("Invalid execution log position");
  return source;
}
