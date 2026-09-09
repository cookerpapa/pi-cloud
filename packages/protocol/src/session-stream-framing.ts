// A part can expand to six JSON bytes per UTF-16 code unit. Keep each SSE
// frame bounded independently of the complete presentation value's size.
export const SESSION_STREAM_PART_CHARACTERS = 16_384;
export const SESSION_STREAM_MAX_FRAME_BYTES = 128 * 1_024;
export const SESSION_STREAM_SEND_TIMEOUT_MS = 30_000;
