/**
 * Supabase returns the QR code as an unencoded SVG data URL
 * ("data:image/svg+xml;utf-8,<svg …>"). Unencoded "#" characters (colours)
 * can truncate such URLs, so it is re-encoded as base64. Only SVG markup is
 * accepted; it is rendered with <img>, where scripts never run.
 */
export function toBase64SvgDataUrl(qr: string): string {
  if (qr.startsWith("data:image/svg+xml;base64,")) return qr;
  const comma = qr.indexOf(",");
  const raw = comma >= 0 && qr.startsWith("data:image/svg+xml") ? qr.slice(comma + 1) : qr;
  let svg = raw;
  try {
    svg = decodeURIComponent(raw);
  } catch {
    // Not URI-encoded: use as is.
  }
  if (!svg.trimStart().startsWith("<svg") && !svg.trimStart().startsWith("<?xml")) {
    throw new Error("Oväntat format på QR-koden");
  }
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}
