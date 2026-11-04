export const LONG_PASTE_CHARACTERS = 4_000;
export const MAX_TEXT_EDITOR_BYTES = 8 * 1024 * 1024;

export function characterCount(text: string): number {
  let count = 0;
  for (const _character of text) count++;
  return count;
}

export function longPasteFile(text: string): { file: File; characters: number } | undefined {
  const characters = characterCount(text);
  if (characters <= LONG_PASTE_CHARACTERS) return undefined;
  return {
    file: new File([text], `pasted-${crypto.randomUUID().slice(0, 8)}.txt`, { type: "text/plain" }),
    characters,
  };
}

export function editableTextFile(name: string, mimeType = ""): boolean {
  return (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    /\.(txt|log|md|markdown|json|csv|tsv|yaml|yml|toml|ini|sh|py|js|ts|tsx|jsx|css|sql)$/i.test(
      name,
    )
  );
}

export function decodeAttachmentText(bytes: Uint8Array): string {
  // Fatal decoding preserves the original instead of saving replacement characters.
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}
