/** Linux NAME_MAX counts encoded bytes; API, Broker and guest share this boundary. */
export function validGuestDirectoryName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 255 &&
    value !== "." &&
    value !== ".." &&
    value.trim() === value &&
    !/[\/\u0000-\u001f\u007f]/u.test(value) &&
    new TextEncoder().encode(value).byteLength <= 255
  );
}
