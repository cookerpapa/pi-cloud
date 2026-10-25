export function isSessionImagePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\/v1\/sessions\/[0-9a-f-]{36}\/images\/[0-9a-f-]{36}$/.test(value)
  );
}

/** Same-origin authenticated immutable assets; no provider URLs or image bytes in views. */
export function SessionImage({
  src,
  alt,
  onLoad,
}: {
  src: string;
  alt: string;
  onLoad?: (() => void) | undefined;
}) {
  if (!isSessionImagePath(src)) return null;
  return (
    <a className="product-session-image" href={src} target="_blank" rel="noreferrer noopener">
      <img
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        onLoad={onLoad}
        style={{ maxWidth: "100%", maxHeight: "60vh", objectFit: "contain" }}
      />
    </a>
  );
}
