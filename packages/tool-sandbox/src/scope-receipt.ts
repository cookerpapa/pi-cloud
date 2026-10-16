/** Fixed launcher outcome, shared by contract with Cubelet's native driver. */
export const SCOPE_RECEIPT_UNCONFIRMED = 76;

/** Only I/O loss/expiry is eligible; malformed controls remain ordinary faults. */
export class ScopeReceiptTransportError extends Error {
  constructor() {
    super("Execution receipt transport unavailable");
  }
}

/** Call only after mode-local work and bookkeeping have succeeded. */
export async function settledScopeReceipt(
  receipt: Promise<unknown>,
  timeoutMs = 5000,
): Promise<0 | typeof SCOPE_RECEIPT_UNCONFIRMED> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      receipt,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ScopeReceiptTransportError()), timeoutMs);
      }),
    ]);
    return 0;
  } catch (error) {
    if (error instanceof ScopeReceiptTransportError) return SCOPE_RECEIPT_UNCONFIRMED;
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
