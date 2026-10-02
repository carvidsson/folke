/** Storage-safe object name: ASCII only, no path separators. */
export function safeObjectName(fileName: string) {
  const base = fileName
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .slice(-120);
  return base || "dokument";
}
