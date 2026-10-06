/** Independent deterministic inputs for the pinned upstream 1.0.0 oracle. */
export function truncationInputs() {
  const texts = [
    "",
    "a",
    "a\n",
    "a\n\n",
    "one\r\ntwo\n",
    "中🙂\n尾",
    "\0\ud800\udc00\ud800",
    "x".repeat(51201),
    "🙂".repeat(13000),
    Array.from({ length: 2003 }, (_, i) => String(i)).join("\n"),
  ];
  const alphabet = ["x", " ", "\n", "\r", "中", "🙂", "\0", "\ud800", "\udc00"];
  let seed = 17;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  for (let i = 0; i < 100; i++)
    texts.push(
      Array.from({ length: random() % 80 }, () => alphabet[random() % alphabet.length]).join(""),
    );
  return texts.flatMap((content) =>
    [
      {},
      { maxBytes: 1, maxLines: 1 },
      { maxBytes: 5, maxLines: 2 },
      { maxBytes: 17, maxLines: 3 },
      { maxBytes: 51200, maxLines: 2000 },
    ].map((options) => ({ content, options })),
  );
}
