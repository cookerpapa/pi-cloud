import {
  ToolResultAttachmentError,
  type ImagePacked,
  type ToolReplyWait,
  type ToolResultPayload,
} from "@pi-cloud/protocol";
import {
  decodeSessionImages,
  type ImageAttachmentCodec,
  type ImageScope,
} from "@pi-cloud/session-attachments";

/** Receipt is known before this stage. S3 failure never changes execution evidence. */
export function restoreToolReply(
  wait: ToolReplyWait<ImagePacked<ToolResultPayload>>,
  codec: ImageAttachmentCodec | undefined,
  scope: ImageScope,
  signal: AbortSignal,
): ToolReplyWait<ToolResultPayload> {
  const result = wait.result.then(async (reply) => {
    try {
      signal.throwIfAborted();
      const restored = await decodeSessionImages<ToolResultPayload>(codec, scope, reply, signal);
      signal.throwIfAborted();
      return restored;
    } catch (cause) {
      signal.throwIfAborted();
      throw new ToolResultAttachmentError({ cause });
    }
  });
  // A fast result can fail decoding before the original intent's ACK is observed.
  void result.catch(() => {});
  return { result, executionSettled: wait.executionSettled };
}
