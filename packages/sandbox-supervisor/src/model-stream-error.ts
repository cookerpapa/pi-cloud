/** Known premature Responses stream endings omitted by Pi 0.84's retry classifier. */
export function isIncompleteModelStreamError(message: string): boolean {
  return /\bstream (?:disconnected before completion|closed before response\.completed|ended before a terminal response event)\b/i.test(
    message,
  );
}
