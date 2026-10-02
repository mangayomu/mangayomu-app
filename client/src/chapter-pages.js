/**
 * Resolve a chapter pages payload into the uniform Reader page model.
 *
 * Image chapters carry per-page image URLs (the legacy `urls` array).
 * PDF chapters declare `format: "pdf"` plus one authenticated PDF URL and
 * are modeled as a single chapter-level page: the host renders the document
 * client-side and reading progress is tracked at the chapter boundary.
 *
 * @param {object|null|undefined} pages
 * @returns {{format: "images"|"pdf", urls: string[], totalPages: number, pdfUrl: string|null}}
 */
export function resolveChapterPages(pages) {
  if (!pages || typeof pages !== "object") {
    return { format: "images", urls: [], totalPages: 0, pdfUrl: null };
  }
  if (pages.format === "pdf" && typeof pages.pdfUrl === "string" && pages.pdfUrl) {
    return { format: "pdf", urls: [], totalPages: 1, pdfUrl: pages.pdfUrl };
  }
  const urls = Array.isArray(pages.urls) ? pages.urls.filter(Boolean) : [];
  return { format: "images", urls, totalPages: urls.length, pdfUrl: null };
}
