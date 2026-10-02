/**
 * panel-detect — client-side manga panel/frame detection.
 *
 * Pure JS, zero dependencies, no wasm. Pipeline ported 1:1 from the
 * validated prototype in fullfill/test-opencv-client4:
 *
 *   1. binary "white" mask (threshold, optional invert)
 *   2. flood-fill of the background from the page borders
 *   3. connected components of everything that is not background
 *   4. confident panels: solid components with >= 3 straight sides
 *      (least-squares fit, image edges count as straight sides)
 *   5. fragments inside a panel bbox are absorbed by that panel
 *   6. recursive XY-cut of the leftover fragments over a summed-area
 *      table: strictly-empty bands always cut; bands guided by the
 *      bottom edges of confident panels cut when part of the gutter is
 *      visible; near-empty bands only cut oversized fused regions
 *   7. reading order: pairwise by reading corner (top-right RTL / top-left LTR)
 *      within each row
 */

const DEFAULTS = {
  /* main options */
  threshold: 210,      // binary white threshold (0-255)
  invert: false,       // true for white-line pages on dark background
  readingOrder: "rtl", // 'rtl' manga | 'ltr' western
  procMax: 1400,       // processing resolution cap (longest side)

  /* internal tuning, validated on the prototype page */
  minCompFrac: 0.00008, // discard specks below this area fraction
  minPanelFrac: 0.01,   // min bbox area fraction for a confident panel
  minRegionFrac: 0.02,  // min bbox area fraction for a region leaf
  fitRmsTol: 3.0,       // max residual RMS (px) for a "straight" side
  fitCoverage: 0.85,    // min fraction of side length the profile must cover
  minPanelFill: 0.5,    // min solidity for a confident panel
  absorbFrac: 0.8,      // bbox containment fraction to absorb a comp into a panel
  cutAggr: 0.85,        // band emptiness for cutting oversized fused regions
  aggrMinArea: 0.20,    // box area fraction of page that enables aggressive cuts
  cutBandMin: 5,        // min band thickness (px)
  minRegionFg: 0.002,   // min fg pixel fraction of page for a region leaf
  guideMinEmpty: 0.3,   // gutter visibility needed to accept a guided cut
  sideMinFrac: 0.10,    // each side of a guided/aggressive cut keeps this much fg
  rowOverlap: 0.35,     // vertical overlap ratio for reading-order rows
  splitFusedPanels: false, // experimental: re-cut oversized confident panels crossed by artwork
};

/**
 * @typedef {Object} PanelBox
 * @property {number} x Left edge, in source image coordinates
 * @property {number} y Top edge, in source image coordinates
 * @property {number} w Width, in source image coordinates
 * @property {number} h Height, in source image coordinates
 * @property {'panel'|'region'} kind 'panel' = confident bordered panel
 * @property {number} order 1-based reading order
 * @property {number} [fill] Solidity (confident panels only, debug)
 * @property {number} [straight] Straight side count (confident panels only, debug)
 */

/**
 * Detect manga panels in a page image.
 *
 * @param {ImageData|HTMLImageElement|HTMLCanvasElement} source
 *   ImageData is processed as-is (worker-safe, caller controls resolution);
 *   an element is downscaled internally to `procMax` via canvas (DOM only).
 * @param {Partial<typeof DEFAULTS>} [options]
 * @returns {{ boxes: PanelBox[], timings: Object }}
 *   Boxes in source coordinates, sorted by reading order.
 */
export function detectPanels(source, options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const t0 = performance.now();
  const { rgba, w, h, k } = readPixels(source, cfg.procMax);

  // 1. binary "white" mask
  const white = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    const g = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
    white[i] = ((g >= cfg.threshold) !== cfg.invert) ? 1 : 0;
  }
  const t1 = performance.now();

  // 2. background = white pixels reachable from the page border
  const bg = floodBackground(white, w, h);
  const t2 = performance.now();

  // 3. connected components of everything that is not background
  const { labels, comps } = labelComponents(bg, w, h);
  const t3 = performance.now();

  // 4-7. classify into panels and regions, reading order
  const boxes = classify(labels, comps, w, h, cfg).map((b) => ({
    ...b,
    x: Math.round(b.x * k),
    y: Math.round(b.y * k),
    w: Math.round(b.w * k),
    h: Math.round(b.h * k),
  }));
  boxes.sort((a, b) => a.order - b.order);
  const t4 = performance.now();

  return {
    boxes,
    timings: { mask: t1 - t0, flood: t2 - t1, label: t3 - t2, classify: t4 - t3, total: t4 - t0 },
  };
}

/* ================= Pixel access ================= */

function readPixels(source, procMax) {
  if (source.data instanceof Uint8ClampedArray) {
    return { rgba: source.data, w: source.width, h: source.height, k: 1 };
  }
  const sw = source.naturalWidth || source.width;
  const sh = source.naturalHeight || source.height;
  const s = Math.min(1, procMax / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * s));
  const h = Math.max(1, Math.round(sh * s));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, w, h);
  return { rgba: ctx.getImageData(0, 0, w, h).data, w, h, k: sw / w };
}

/* ================= Background flood ================= */

function floodBackground(white, w, h) {
  const bg = new Uint8Array(w * h);
  const q = new Int32Array(w * h);
  let qt = 0;
  const seed = (i) => { if (white[i] && !bg[i]) { bg[i] = 1; q[qt++] = i; } };
  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
  for (let y = 1; y < h - 1; y++) { seed(y * w); seed(y * w + w - 1); }
  for (let qh = 0; qh < qt; qh++) {
    const i = q[qh], x = i - ((i / w) | 0) * w;
    let n;
    if (x > 0)     { n = i - 1; if (white[n] && !bg[n]) { bg[n] = 1; q[qt++] = n; } }
    if (x < w - 1) { n = i + 1; if (white[n] && !bg[n]) { bg[n] = 1; q[qt++] = n; } }
    n = i - w; if (n >= 0    && white[n] && !bg[n]) { bg[n] = 1; q[qt++] = n; }
    n = i + w; if (n < w * h && white[n] && !bg[n]) { bg[n] = 1; q[qt++] = n; }
  }
  return bg;
}

/* ================= Connected components ================= */

function labelComponents(bg, w, h) {
  const labels = new Int32Array(w * h);
  const q = new Int32Array(w * h);
  const comps = [];
  let id = 0;
  for (let start = 0; start < w * h; start++) {
    if (bg[start] || labels[start]) continue;
    id++;
    const c = { id, area: 0, minX: w, minY: h, maxX: 0, maxY: 0 };
    labels[start] = id;
    q[0] = start;
    let qt = 1;
    for (let qh = 0; qh < qt; qh++) {
      const i = q[qh], y = (i / w) | 0, x = i - y * w;
      c.area++;
      if (x < c.minX) c.minX = x;
      if (x > c.maxX) c.maxX = x;
      if (y < c.minY) c.minY = y;
      if (y > c.maxY) c.maxY = y;
      let n;
      if (x > 0)     { n = i - 1; if (!bg[n] && !labels[n]) { labels[n] = id; q[qt++] = n; } }
      if (x < w - 1) { n = i + 1; if (!bg[n] && !labels[n]) { labels[n] = id; q[qt++] = n; } }
      n = i - w; if (n >= 0    && !bg[n] && !labels[n]) { labels[n] = id; q[qt++] = n; }
      n = i + w; if (n < w * h && !bg[n] && !labels[n]) { labels[n] = id; q[qt++] = n; }
    }
    comps.push(c);
  }
  return { labels, comps };
}

/* ================= Classification ================= */

function classify(labels, comps, w, h, cfg) {
  const page = w * h;
  const minArea = Math.max(24, page * cfg.minCompFrac);
  const big = comps.filter((c) => c.area >= minArea && c.maxX - c.minX > 8 && c.maxY - c.minY > 8);

  const panels = [], rest = [];
  for (const c of big) {
    const bw = c.maxX - c.minX + 1, bh = c.maxY - c.minY + 1;
    c.fill = c.area / (bw * bh);
    c.straight = straightSides(labels, c, w, h, cfg);
    if (bw * bh >= page * cfg.minPanelFrac && c.straight >= 3 && c.fill >= cfg.minPanelFill) {
      panels.push(c);
    } else {
      rest.push(c);
    }
  }

  // fragments inside a panel bbox belong to that panel
  const leftovers = rest.filter((c) => !panels.some((p) => containedFrac(c, p) >= cfg.absorbFrac));

  // mask of leftover pixels only, then recursive XY-cut along empty gutter bands
  const isLeft = new Uint8Array(comps.length + 2);
  for (const c of leftovers) isLeft[c.id] = 1;
  const leftMask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) leftMask[i] = isLeft[labels[i]];
  const sat = buildSAT(leftMask, w, h);

  // panels in a manga row share their gutter line: their bottom edges guide cuts
  // through regions the projection alone cannot split (art bleeding over borders)
  const guides = panels.map((p) => p.maxY + 3).sort((a, b) => a - b);

  const leaves = [];
  cutRegions(sat, w + 1, { x0: 0, y0: 0, x1: w - 1, y1: h - 1 }, page, guides, cfg, leaves, 0);
  const regions = leaves.filter((r) => {
    const c = { minX: r.x0, minY: r.y0, maxX: r.x1, maxY: r.y1 };
    return (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1) >= page * cfg.minRegionFrac &&
           !panels.some((p) => containedFrac(c, p) >= cfg.absorbFrac);
  });

  const resolvedPanels = cfg.splitFusedPanels
    ? panels.flatMap((panel) => splitFusedPanel(panel, labels, w, h, page, cfg))
    : panels;
  const resolvedRegions = cfg.splitFusedPanels
    ? regions.flatMap((region) => splitFusedRegion(region, sat, w + 1, page, cfg))
    : regions;
  const boxes = [
    ...resolvedPanels.map((c) => ({ x: c.minX, y: c.minY, w: c.maxX - c.minX + 1, h: c.maxY - c.minY + 1,
                            kind: "panel", fill: c.fill, straight: c.straight })),
    ...resolvedRegions.map((r) => ({ x: r.x0, y: r.y0, w: r.x1 - r.x0 + 1, h: r.y1 - r.y0 + 1,
                                     kind: "region" })),
  ];
  readingOrder(boxes, cfg);
  return boxes;
}

/* Re-run the existing XY-cut over a large confident component. A character that
   crosses one gutter fuses two panels into a valid-looking component, so the
   regular leftovers-only cut never gets a chance to separate it. */
function splitFusedPanel(panel, labels, w, h, page, cfg) {
  const width = panel.maxX - panel.minX + 1;
  const height = panel.maxY - panel.minY + 1;
  if (width * height < page * cfg.aggrMinArea) return [panel];

  const mask = new Uint8Array(w * h);
  for (let y = panel.minY; y <= panel.maxY; y++) {
    for (let x = panel.minX; x <= panel.maxX; x++) {
      if (labels[y * w + x] === panel.id) mask[y * w + x] = 1;
    }
  }
  const sat = buildSAT(mask, w, h);
  const leaves = [];
  cutRegions(
    sat,
    w + 1,
    { x0: panel.minX, y0: panel.minY, x1: panel.maxX, y1: panel.maxY },
    page,
    [],
    { ...cfg, aggrMinArea: 0, cutAggr: Math.min(cfg.cutAggr, .5), sideMinFrac: .15 },
    leaves,
    0
  );
  if (leaves.length < 2) return [panel];

  const split = leaves.filter((leaf) => (
    (leaf.x1 - leaf.x0 + 1) * (leaf.y1 - leaf.y0 + 1) >= page * cfg.minPanelFrac
  ));
  if (split.length < 2) return [panel];
  return split.map((leaf) => {
    const area = satSum(sat, w + 1, leaf.x0, leaf.y0, leaf.x1, leaf.y1);
    const boxArea = (leaf.x1 - leaf.x0 + 1) * (leaf.y1 - leaf.y0 + 1);
    return {
      ...panel,
      minX: leaf.x0,
      minY: leaf.y0,
      maxX: leaf.x1,
      maxY: leaf.y1,
      area,
      fill: area / boxArea,
    };
  });
}

/* A macro-region can be formed by several leftover components bridged by a
   character, so it never appears in the confident-panel list above. Its mask
   already exists in the leftovers SAT; run a deliberately conservative second
   cut only on wide/tall regions that are large enough to plausibly hold panels. */
function splitFusedRegion(region, sat, W, page, cfg) {
  const width = region.x1 - region.x0 + 1;
  const height = region.y1 - region.y0 + 1;
  const area = width * height;
  const aspect = Math.max(width / Math.max(1, height), height / Math.max(1, width));
  if (area < page * .1 || aspect < 1.35) return [region];

  const leaves = [];
  cutRegions(
    sat,
    W,
    { x0: region.x0, y0: region.y0, x1: region.x1, y1: region.y1 },
    page,
    [],
    { ...cfg, aggrMinArea: 0, cutAggr: Math.min(cfg.cutAggr, .78), sideMinFrac: .15 },
    leaves,
    0
  );
  const split = leaves.filter((leaf) => (
    (leaf.x1 - leaf.x0 + 1) * (leaf.y1 - leaf.y0 + 1) >= page * cfg.minRegionFrac
  ));
  return split.length >= 2 ? split : [region];
}

/* A side is straight when the component touches the image edge there, or when the
   boundary profile fits a line (any slope) with low residual — slanted borders pass. */
function straightSides(labels, c, w, h, cfg) {
  let count = 0;
  count += (c.minY <= 1 || fitProfile(profileH(labels, c, w, true), cfg))  ? 1 : 0;
  count += (c.maxY >= h - 2 || fitProfile(profileH(labels, c, w, false), cfg)) ? 1 : 0;
  count += (c.minX <= 1 || fitProfile(profileV(labels, c, w, true), cfg))  ? 1 : 0;
  count += (c.maxX >= w - 2 || fitProfile(profileV(labels, c, w, false), cfg)) ? 1 : 0;
  return count;
}

function profileH(labels, c, w, top) {
  const pts = [];
  for (let x = c.minX; x <= c.maxX; x++) {
    if (top) {
      for (let y = c.minY; y <= c.maxY; y++) if (labels[y * w + x] === c.id) { pts.push(x, y); break; }
    } else {
      for (let y = c.maxY; y >= c.minY; y--) if (labels[y * w + x] === c.id) { pts.push(x, y); break; }
    }
  }
  return { pts, span: c.maxX - c.minX + 1 };
}

function profileV(labels, c, w, left) {
  const pts = [];
  for (let y = c.minY; y <= c.maxY; y++) {
    if (left) {
      for (let x = c.minX; x <= c.maxX; x++) if (labels[y * w + x] === c.id) { pts.push(y, x); break; }
    } else {
      for (let x = c.maxX; x >= c.minX; x--) if (labels[y * w + x] === c.id) { pts.push(y, x); break; }
    }
  }
  return { pts, span: c.maxY - c.minY + 1 };
}

function fitProfile({ pts, span }, cfg) {
  const n = pts.length / 2;
  if (n < Math.max(8, span * cfg.fitCoverage)) return false;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < pts.length; i += 2) {
    sx += pts[i]; sy += pts[i + 1]; sxx += pts[i] * pts[i]; sxy += pts[i] * pts[i + 1];
  }
  const den = n * sxx - sx * sx;
  const a = den === 0 ? 0 : (n * sxy - sx * sy) / den;
  const b = (sy - a * sx) / n;
  let se = 0;
  for (let i = 0; i < pts.length; i += 2) {
    const e = pts[i + 1] - (a * pts[i] + b);
    se += e * e;
  }
  return Math.sqrt(se / n) <= cfg.fitRmsTol;
}

function containedFrac(c, p) {
  const ix = Math.max(0, Math.min(c.maxX, p.maxX) - Math.max(c.minX, p.minX) + 1);
  const iy = Math.max(0, Math.min(c.maxY, p.maxY) - Math.max(c.minY, p.minY) + 1);
  return (ix * iy) / ((c.maxX - c.minX + 1) * (c.maxY - c.minY + 1));
}

/* ================= XY-cut over a summed-area table ================= */

function buildSAT(mask, w, h) {
  const W = w + 1;
  const sat = new Uint32Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let acc = 0;
    for (let x = 0; x < w; x++) {
      acc += mask[y * w + x];
      sat[(y + 1) * W + x + 1] = sat[y * W + x + 1] + acc;
    }
  }
  return sat;
}

function satSum(sat, W, x0, y0, x1, y1) {
  return sat[(y1 + 1) * W + x1 + 1] - sat[y0 * W + x1 + 1] - sat[(y1 + 1) * W + x0] + sat[y0 * W + x0];
}

/* Recursively split a box along near-empty horizontal/vertical bands.
   Clean bands always cut; partially-crossed bands (art bleeding over a border)
   only cut boxes so large they are clearly several panels fused together. */
function cutRegions(sat, W, box, page, guides, cfg, out, depth) {
  // tighten to the actual fragment bbox
  while (box.y0 <= box.y1 && satSum(sat, W, box.x0, box.y0, box.x1, box.y0) === 0) box.y0++;
  while (box.y1 >= box.y0 && satSum(sat, W, box.x0, box.y1, box.x1, box.y1) === 0) box.y1--;
  while (box.x0 <= box.x1 && satSum(sat, W, box.x0, box.y0, box.x0, box.y1) === 0) box.x0++;
  while (box.x1 >= box.x0 && satSum(sat, W, box.x1, box.y0, box.x1, box.y1) === 0) box.x1--;
  if (box.x0 > box.x1 || box.y0 > box.y1) return;
  if (satSum(sat, W, box.x0, box.y0, box.x1, box.y1) < page * cfg.minRegionFg) return;

  if (depth < 10) {
    const found = pickBands(sat, W, box, page, guides, cfg);
    if (found) {
      const lo = found.horiz ? box.y0 : box.x0;
      const hi = found.horiz ? box.y1 : box.x1;
      let prev = lo;
      for (const cut of [...found.bands, hi + 1]) {
        const sub = found.horiz
          ? { x0: box.x0, y0: prev, x1: box.x1, y1: cut - 1 }
          : { x0: prev, y0: box.y0, x1: cut - 1, y1: box.y1 };
        cutRegions(sat, W, sub, page, guides, cfg, out, depth + 1);
        prev = cut;
      }
      return;
    }
  }
  out.push(box);
}

function pickBands(sat, W, box, page, guides, cfg) {
  const area = (box.x1 - box.x0 + 1) * (box.y1 - box.y0 + 1);
  const boxFg = satSum(sat, W, box.x0, box.y0, box.x1, box.y1);
  const substantial = (horiz, cut) => {
    const before = horiz
      ? satSum(sat, W, box.x0, box.y0, box.x1, cut - 1)
      : satSum(sat, W, box.x0, box.y0, cut - 1, box.y1);
    return Math.min(before, boxFg - before) >= boxFg * cfg.sideMinFrac;
  };

  const tiers = [
    { horiz: true, clean: true }, { horiz: false, clean: true },
    { horiz: true, guided: true },
  ];
  if (area >= page * cfg.aggrMinArea) {
    tiers.push({ horiz: true, minEmpty: cfg.cutAggr, validate: true },
               { horiz: false, minEmpty: cfg.cutAggr, validate: true });
  }
  for (const tier of tiers) {
    let bands = tier.guided
      ? guideBands(sat, W, box, guides, cfg)
      : scanBands(sat, W, box, tier.horiz, tier.clean ? 1 : tier.minEmpty, cfg);
    if (tier.guided || tier.validate) bands = bands.filter((cut) => substantial(tier.horiz, cut));
    if (bands.length) return { horiz: tier.horiz, bands };
  }
  return null;
}

/* Bottom edges of confident panels, projected across the box: accepted when at
   least part of the gutter is visible along the line. */
function guideBands(sat, W, box, guides, cfg) {
  const len = box.x1 - box.x0 + 1;
  const bands = [];
  for (const y of guides) {
    if (y < box.y0 + 8 || y > box.y1 - 8) continue;
    const fg = satSum(sat, W, box.x0, y - 1, box.x1, y + 3);
    if (1 - fg / (len * 5) >= cfg.guideMinEmpty) bands.push(y);
  }
  return bands;
}

function scanBands(sat, W, box, horiz, minEmpty, cfg) {
  const bands = [];
  const len = horiz ? box.x1 - box.x0 + 1 : box.y1 - box.y0 + 1;
  const lo = (horiz ? box.y0 : box.x0) + 3;
  const hi = (horiz ? box.y1 : box.x1) - 3;
  let start = -1;
  for (let p = lo; p <= hi; p++) {
    const fg = horiz
      ? satSum(sat, W, box.x0, p, box.x1, p)
      : satSum(sat, W, p, box.y0, p, box.y1);
    if (minEmpty >= 1 ? fg === 0 : 1 - fg / len >= minEmpty) {
      if (start < 0) start = p;
    } else {
      if (start >= 0 && p - start >= cfg.cutBandMin) bands.push((start + p - 1) >> 1);
      start = -1;
    }
  }
  if (start >= 0 && hi + 1 - start >= cfg.cutBandMin) bands.push((start + hi) >> 1);
  return bands;
}

/* ================= Reading order ================= */

/* Order by pairwise relative position of the reading corner (top-right for RTL):
   boxes that overlap vertically read side-first, otherwise the higher one first.
   Each step picks a box no other box precedes — no accumulated rows, so a tall
   side panel spanning stacked panels cannot swallow them into one x-only row. */
function readingOrder(boxes, cfg) {
  const rtl = cfg.readingOrder !== "ltr";
  const before = (a, b) => {
    const ov = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    if (ov / Math.min(a.h, b.h) >= cfg.rowOverlap)
      return rtl ? a.x + a.w > b.x + b.w : a.x < b.x;
    return a.y < b.y;
  };
  const rest = [...boxes];
  let n = 0;
  while (rest.length) {
    let pick = 0;
    for (let i = 0; i < rest.length; i++)
      if (!rest.some((o, j) => j !== i && before(o, rest[i]))) { pick = i; break; }
    rest.splice(pick, 1)[0].order = ++n;
  }
}
