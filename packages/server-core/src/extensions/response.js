/**
 * Response-shape helpers for generic extension request results.
 *
 * An installed extension may answer a request with a binary payload
 * ({ status, contentType, body: Buffer/Uint8Array }), a redirect
 * ({ status, location }), or plain JSON data. These predicates keep the
 * host route logic pure and testable, and parse `mangayomu-image://` tokens
 * that extension sources use for page/cover URLs.
 */

/** True when an extension result is a binary payload response. */
export function isBinaryResult(result) {
  if (!result || typeof result !== "object") return false;
  if (!Number.isInteger(result.status)) return false;
  const body = result.body;
  const isBytes = Buffer.isBuffer(body) || body instanceof Uint8Array;
  return isBytes && typeof result.contentType === "string" && result.contentType.length > 0;
}

/** True when an extension result is a redirect. */
export function isRedirectResult(result) {
  if (!result || typeof result !== "object") return false;
  if (!Number.isInteger(result.status)) return false;
  if (result.status < 300 || result.status >= 400) return false;
  return typeof result.location === "string" && result.location.length > 0;
}

/**
 * True when a redirect result points at an HTTP(S) target that the image
 * proxy should fetch on the user's behalf (preserving upstream header
 * policy). Relative or non-http targets are handed back to the browser.
 */
export function shouldProxyRedirect(location) {
  return typeof location === "string" && /^https?:\/\//i.test(location);
}

/**
 * Parse an extension-owned image token such as
 * `mangayomu-image://image?chapter=…&file=…` into { path, query }.
 * Returns null for any other URL so normal proxy URLs pass through.
 */
export function parseExtensionImageUrl(url) {
  if (typeof url !== "string" || !url.startsWith("mangayomu-image://")) return null;
  const rest = url.slice("mangayomu-image://".length);
  const qIndex = rest.indexOf("?");
  const path = qIndex < 0 ? rest : rest.slice(0, qIndex);
  const rawQuery = qIndex < 0 ? "" : rest.slice(qIndex + 1);
  const query = {};
  for (const part of rawQuery.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const key = eq < 0 ? part : part.slice(0, eq);
    const value = eq < 0 ? "" : decodeURIComponent(part.slice(eq + 1));
    query[key] = value;
  }
  return { path, query };
}