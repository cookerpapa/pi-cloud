import { useEffect, useState } from "react";
import type { TenantIdentityResource } from "@pi-cloud/protocol";

export type ComposerEnterMode = "follow_up" | "steer";

function readMode(key: string | null): ComposerEnterMode {
  try {
    return key && globalThis.localStorage?.getItem(key) === "steer" ? "steer" : "follow_up";
  } catch {
    return "follow_up";
  }
}

/** A browser preference, independent of the Session and its already accepted inputs. */
export function useComposerEnterMode(
  identity: Pick<TenantIdentityResource, "tenantId" | "userId"> | null,
) {
  const key = identity ? `pi-cloud:composer-enter:${identity.tenantId}:${identity.userId}` : null;
  const [preference, setPreference] = useState(() => ({ key, mode: readMode(key) }));
  // Do not briefly apply the previous account's choice while identity is changing.
  if (preference.key !== key) setPreference({ key, mode: readMode(key) });
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === key || event.key === null) setPreference({ key, mode: readMode(key) });
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [key]);
  return {
    enterMode: preference.key === key ? preference.mode : readMode(key),
    setEnterMode(mode: ComposerEnterMode) {
      setPreference({ key, mode });
      try {
        if (key) globalThis.localStorage?.setItem(key, mode);
      } catch {
        // Sending remains usable when browser persistence is unavailable.
      }
    },
  };
}
