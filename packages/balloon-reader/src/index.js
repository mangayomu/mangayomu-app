export { BalloonTextDetector } from "./balloon-text-detector.js";

// Lazy balloon/OCR analysis. Imported only by opt-in reader/fullfill features.
const DEFAULTS = { threshold: 205, procMax: 1400, minArea: 0.003, language: "eng", minTextConfidence: 0.35, minLetters: 3 };
let workerPromise = null;
let workerLanguage = null;

/**
 * OCR-only page analysis for the reader experiment. This deliberately does
 * not invoke white-component/balloon detection: Tesseract sees the original
 * page and returns raw word boxes in original-page coordinates.
 */
export async function analyzePageOcr(image, options = {}) {
  const cfg = { ...DEFAULTS, pageSegMode: "11", ...options };
  const worker = await getWorker(cfg.language);
  const { data } = await worker.recognize(image, { tessedit_pageseg_mode: String(cfg.pageSegMode) }, { blocks: true });
  const words = extractWords(data).map((word) => {
    const bbox = word.bbox || {};
    const text = String(word.text || "").trim();
    if (!text || !Number.isFinite(bbox.x0) || !Number.isFinite(bbox.y0) || !Number.isFinite(bbox.x1) || !Number.isFinite(bbox.y1)) return null;
    return { text, confidence: Number(word.confidence || 0) / 100, box: { x: Math.round(bbox.x0), y: Math.round(bbox.y0), w: Math.round(bbox.x1 - bbox.x0), h: Math.round(bbox.y1 - bbox.y0) } };
  }).filter((word) => word.box.w > 0 && word.box.h > 0);
  return { words, text: String(data.text || "").replace(/\s+/g, " ").trim(), config: { language: cfg.language, pageSegMode: cfg.pageSegMode, output: "blocks" } };
}

/** Analyze a whole page through legacy balloon detection. */
export async function analyzePage(image, options = {}) {
  return analyzeRegion(image, { x: 0, y: 0, w: image.naturalWidth, h: image.naturalHeight }, options);
}

/** Analyze one page region; retained for existing panel-specific callers. */
export async function analyzePanel(image, panel, options = {}) {
  return analyzeRegion(image, panel, options);
}

async function analyzeRegion(image, region, options) {
  const cfg = { ...DEFAULTS, ...options };
  const crop = cropRegion(image, region, cfg.procMax);
  const candidates = findBalloons(crop.ctx.getImageData(0, 0, crop.w, crop.h), cfg);
  if (!candidates.length) return { balloons: [], rejectedCandidates: [], totalCharacters: 0, region };
  const worker = await getWorker(cfg.language);
  const balloons = [], rejectedCandidates = [];
  for (const candidate of candidates) {
    const pad = 4;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, candidate.w - pad * 2);
    canvas.height = Math.max(1, candidate.h - pad * 2);
    canvas.getContext("2d").drawImage(crop.canvas, candidate.x + pad, candidate.y + pad, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
    // Tesseract v7 disables every granular output by default. `blocks` carries
    // paragraphs → lines → words → symbols with their OCR-canvas bboxes.
    const { data } = await worker.recognize(canvas, {}, { blocks: true });
    const confidence = Number(data.confidence || 0) / 100;
    const balloonBox = { x: Math.round(region.x + candidate.x * crop.scale), y: Math.round(region.y + candidate.y * crop.scale), w: Math.round(candidate.w * crop.scale), h: Math.round(candidate.h * crop.scale) };
    const originX = region.x + (candidate.x + pad) * crop.scale;
    const originY = region.y + (candidate.y + pad) * crop.scale;
    // Preserve every meaningful OCR token and its bbox for a credible balloon.
    // In particular, do not discard standalone I or words close to a balloon
    // edge: those are common and valid manga lettering positions.
    const rawWords = extractWords(data).map((word) => {
      const text = String(word.text || "").trim(), bbox = word.bbox || {};
      if (!text || !Number.isFinite(bbox.x0) || !Number.isFinite(bbox.y0) || !Number.isFinite(bbox.x1) || !Number.isFinite(bbox.y1)) return null;
      const width = bbox.x1 - bbox.x0, height = bbox.y1 - bbox.y0;
      if (width <= 0 || height <= 0) return null;
      return { text, confidence: Number(word.confidence || 0) / 100, box: { x: Math.round(originX + bbox.x0 * crop.scale), y: Math.round(originY + bbox.y0 * crop.scale), w: Math.round(width * crop.scale), h: Math.round(height * crop.scale) } };
    }).filter(Boolean);
    // Reveal words exclude punctuation-only OCR noise, but do not impose a
    // per-word confidence, length, or edge-position threshold.
    const words = rawWords.filter((word) => /[\p{L}\p{N}]/u.test(word.text));
    const text = words.map((word) => word.text).join(" ");
    const letters = [...text].filter((char) => /\p{L}/u.test(char)).length;
    // Candidate rejection is aggregate-only. Isolated art candidates from
    // image-copy.png have at most one accidental letter; real dialogue has
    // enough aggregate text, or multiple text-bearing OCR words.
    const credible = letters >= cfg.minLetters && (confidence >= cfg.minTextConfidence || words.length >= 2);
    if (!credible) {
      rejectedCandidates.push({ box: balloonBox, reason: letters < cfg.minLetters ? "fewer than " + cfg.minLetters + " OCR letters" : "low aggregate confidence and fewer than two text words", confidence, rawWords, acceptedWords: words, diagnostics: { letters, textWordCount: words.length } });
      continue;
    }
    balloons.push({ box: balloonBox, shape: "speech", text, confidence, rawWords, words, acceptance: { reason: "credible aggregate OCR", letters, textWordCount: words.length } });
  }
  const ordered = orderMangaBalloons(balloons);
  ordered.forEach((item, index) => { item.readingOrder = index + 1; item.words = orderMangaWords(item.words); });
  return { balloons: ordered, rejectedCandidates, totalCharacters: ordered.reduce((count, item) => count + [...item.text].length, 0), region };
}

function extractWords(data) {
  if (Array.isArray(data.words)) return data.words;
  return (data.blocks || []).flatMap((block) => (block.paragraphs || []).flatMap((paragraph) => (paragraph.lines || []).flatMap((line) => line.words || [])));
}

function orderMangaBalloons(items) { return orderManga(items, (item) => item.box); }
function orderMangaWords(items) { return orderManga(items, (item) => item.box); }
function orderManga(items, getBox) {
  const rows = [];
  for (const item of [...items].sort((a, b) => { const aa = getBox(a), bb = getBox(b); return (aa.y + aa.h / 2) - (bb.y + bb.h / 2); })) {
    const box = getBox(item), center = box.y + box.h / 2;
    const row = rows.find((candidate) => Math.abs(candidate.center - center) <= Math.max(candidate.height, box.h) * 0.45);
    if (row) { row.items.push(item); row.center = row.items.reduce((sum, entry) => { const b = getBox(entry); return sum + b.y + b.h / 2; }, 0) / row.items.length; row.height = Math.max(row.height, box.h); }
    else rows.push({ center, height: box.h, items: [item] });
  }
  return rows.sort((a, b) => a.center - b.center).flatMap((row) => row.items.sort((a, b) => getBox(b).x - getBox(a).x));
}

export async function terminateBalloonReader() {
  if (!workerPromise) return;
  const worker = await workerPromise;
  await worker.terminate(); workerPromise = null; workerLanguage = null;
}
async function getWorker(language) {
  if (!workerPromise || workerLanguage !== language) {
    if (workerPromise) { const previous = await workerPromise; await previous.terminate(); }
    workerLanguage = language;
    workerPromise = import("tesseract.js").then((module) => {
      const createWorker = module.createWorker || module.default?.createWorker;
      if (typeof createWorker !== "function") throw new TypeError("Tesseract createWorker is unavailable.");
      return createWorker(language);
    });
  }
  return workerPromise;
}
function cropRegion(image, region, procMax) {
  const scale = Math.max(region.w, region.h) / Math.min(procMax, Math.max(region.w, region.h));
  const w = Math.max(1, Math.round(region.w / scale)), h = Math.max(1, Math.round(region.h / scale));
  const canvas = document.createElement("canvas"); canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, region.x, region.y, region.w, region.h, 0, 0, w, h);
  return { canvas, ctx, w, h, scale };
}
function findBalloons({ data, width: w, height: h }, cfg) {
  const white = new Uint8Array(w * h), seen = new Uint8Array(w * h), queue = new Int32Array(w * h), out = [];
  for (let i = 0, p = 0; i < white.length; i++, p += 4) white[i] = ((data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8) >= cfg.threshold;
  for (let start = 0; start < white.length; start++) {
    if (!white[start] || seen[start]) continue;
    let qh = 0, qt = 1, area = 0, minX = w, minY = h, maxX = 0, maxY = 0, edge = false; queue[0] = start; seen[start] = 1;
    while (qh < qt) { const i = queue[qh++], y = (i / w) | 0, x = i - y * w; area++; minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); edge ||= x === 0 || y === 0 || x === w - 1 || y === h - 1;
      for (const n of [i - 1, i + 1, i - w, i + w]) if (n >= 0 && n < white.length && !seen[n] && white[n] && Math.abs((n % w) - x) <= 1) { seen[n] = 1; queue[qt++] = n; }
    }
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    if (!edge && area >= w * h * cfg.minArea && area / (bw * bh) > .45 && bw > 18 && bh > 12) out.push({ x: minX, y: minY, w: bw, h: bh });
  }
  return out;
}
