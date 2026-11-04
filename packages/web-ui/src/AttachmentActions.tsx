import { createContext, type ReactNode } from "react";
import type { UserUpload } from "@pi-cloud/protocol";

export const AttachmentActionsContext = createContext<((upload: UserUpload) => void) | undefined>(
  undefined,
);
export function AttachmentActions({
  onReuse,
  children,
}: {
  onReuse: ((upload: UserUpload) => void) | undefined;
  children: ReactNode;
}) {
  return (
    <AttachmentActionsContext.Provider value={onReuse}>
      {children}
    </AttachmentActionsContext.Provider>
  );
}
