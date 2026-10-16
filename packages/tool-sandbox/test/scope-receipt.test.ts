import { afterEach, expect, it, vi } from "vitest";
import {
  ScopeReceiptTransportError,
  SCOPE_RECEIPT_UNCONFIRMED,
  settledScopeReceipt,
} from "../src/scope-receipt.ts";

afterEach(() => vi.useRealTimers());

it("accepts a receipt that arrived before local settlement", async () => {
  expect(await settledScopeReceipt(Promise.resolve())).toBe(0);
});

it("distinguishes an absent reverse receipt without reporting execution failure", async () => {
  vi.useFakeTimers();
  const pending = settledScopeReceipt(new Promise(() => {}));
  await vi.advanceTimersByTimeAsync(5000);
  expect(await pending).toBe(SCOPE_RECEIPT_UNCONFIRMED);
  expect(vi.getTimerCount()).toBe(0);
});

it("retains the receipt-only outcome on input closure after local completion", async () => {
  expect(await settledScopeReceipt(Promise.reject(new ScopeReceiptTransportError()))).toBe(76);
});

it("never hides an invalid control or failed local operation as receipt loss", async () => {
  for (const reason of ["Invalid execution control frame", "cgroup unavailable", "child failed"])
    await expect(settledScopeReceipt(Promise.reject(new Error(reason)))).rejects.toThrow(reason);
});

it("joins a late receipt before its bound and retires the timer", async () => {
  vi.useFakeTimers();
  const deferred = Promise.withResolvers<void>();
  const result = settledScopeReceipt(deferred.promise);
  await vi.advanceTimersByTimeAsync(4000);
  deferred.resolve();
  expect(await result).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});
