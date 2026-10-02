/**
 * Browser-only OCR detector for text phrases inside manga balloons.
 * The host supplies the Tesseract-compatible worker factory so this module
 * remains lazy-loadable from the Reader.
 */
export class BalloonTextDetector {
  static defaults = Object.freeze({
    confidence: 60,
    minLetters: 2,
    mergeGap: 1,
    mergeGapPixel: undefined,
  });

  constructor({ createWorker, language = "eng", discoveryPsm = "11", refinementPsm = "6" } = {}) {
    if (typeof createWorker !== "function") {
      throw new TypeError("BalloonTextDetector requires a Tesseract createWorker function.");
    }
    this.createWorker = createWorker;
    this.language = language;
    this.discoveryPsm = discoveryPsm;
    this.refinementPsm = refinementPsm;
  }

  async detect(source, {
    confidence = BalloonTextDetector.defaults.confidence,
    minLetters = BalloonTextDetector.defaults.minLetters,
    mergeGap = BalloonTextDetector.defaults.mergeGap,
    mergeGapPixel = BalloonTextDetector.defaults.mergeGapPixel,
    onProgress = () => {},
  } = {}) {
    const { width, height } = this.#dimensions(source);
    const worker = await this.createWorker(this.language, 1, {
      logger: (event) => onProgress({ phase: "discovery", ...event }),
    });

    try {
      onProgress({ phase: "discovery", status: "starting", progress: 0 });
      await worker.setParameters({ tessedit_pageseg_mode: this.discoveryPsm });
      // Tesseract v7 disables granular geometry unless it is requested.
      // Older builds still populate data.lines, so support both shapes.
      const { data } = await worker.recognize(source, {}, { blocks: true });
      const candidates = this.#mergeLines(
        this.#filterLines(this.#lines(data), { confidence, minLetters }),
        { mergeGap, mergeGapPixel },
      );

      await worker.setParameters({ tessedit_pageseg_mode: this.refinementPsm });
      const phrases = [];
      for (let index = 0; index < candidates.length; index += 1) {
        onProgress({ phase: "refinement", status: "recognizing text", progress: (index + 1) / candidates.length, current: index + 1, total: candidates.length });
        try {
          const crop = this.#createCrop(source, candidates[index].bbox, width, height);
          const { data: refined } = await worker.recognize(crop.canvas, {}, { blocks: true });
          phrases.push(this.#refineCandidate(candidates[index], refined, crop));
        } catch (error) {
          // Direct browser sources can be displayable/OCR-able yet taint a
          // DOM canvas. Keep the full-page OCR geometry instead of dropping
          // the phrase; Reader will use its white-mask fallback for colour.
          if (error?.name !== "SecurityError") throw error;
          phrases.push({ ...candidates[index], refined: false });
        }
      }

      onProgress({ phase: "complete", status: "done", progress: 1 });
      return phrases;
    } finally {
      await worker.terminate();
    }
  }

  #dimensions(source) {
    const width = source.naturalWidth || source.videoWidth || source.width;
    const height = source.naturalHeight || source.videoHeight || source.height;
    if (!width || !height) throw new TypeError("The source must expose a non-zero width and height.");
    return { width, height };
  }

  #filterLines(lines, { confidence, minLetters }) {
    return lines.filter((line) => {
      const letters = (line.text.match(/[a-z]/gi) || []).length;
      const boxHeight = line.bbox?.y1 - line.bbox?.y0;
      return line.bbox && letters >= minLetters && line.confidence >= confidence && boxHeight >= 10;
    });
  }

  #mergeLines(lines, { mergeGap, mergeGapPixel }) {
    const lineHeights = lines.map((line) => line.bbox.y1 - line.bbox.y0).sort((a, b) => a - b);
    const medianLineHeight = lineHeights.length ? lineHeights[Math.floor(lineHeights.length / 2)] : 0;
    const maximumGap = Number.isFinite(mergeGapPixel) ? mergeGapPixel : medianLineHeight * mergeGap;
    const groups = [];
    const sorted = [...lines].sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);

    for (const line of sorted) {
      const matchingGroup = groups.find((group) => {
        const previous = group.lines[group.lines.length - 1];
        const verticalGap = line.bbox.y0 - previous.bbox.y1;
        const overlap = Math.max(0, Math.min(line.bbox.x1, previous.bbox.x1) - Math.max(line.bbox.x0, previous.bbox.x0));
        const narrowest = Math.min(line.bbox.x1 - line.bbox.x0, previous.bbox.x1 - previous.bbox.x0);
        return verticalGap >= -10 && verticalGap <= maximumGap && overlap / narrowest >= 0.25;
      });
      (matchingGroup || groups[groups.push({ lines: [] }) - 1]).lines.push(line);
    }

    return groups.map((group) => {
      const groupLines = group.lines.sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);
      return {
        text: groupLines.map((line) => line.text.trim()).join(" "),
        confidence: groupLines.reduce((sum, line) => sum + line.confidence, 0) / groupLines.length,
        bbox: this.#unionBoxes(groupLines.map((line) => line.bbox)),
      };
    });
  }

  #createCrop(source, bbox, imageWidth, imageHeight) {
    const paddingX = 8;
    const paddingY = 30;
    const scale = 3;
    const x0 = Math.max(0, bbox.x0 - paddingX);
    const y0 = Math.max(0, bbox.y0 - paddingY);
    const x1 = Math.min(imageWidth, bbox.x1 + paddingX);
    const y1 = Math.min(imageHeight, bbox.y1 + paddingY);
    const sourceWidth = x1 - x0;
    const sourceHeight = y1 - y0;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(sourceWidth * scale);
    canvas.height = Math.round(sourceHeight * scale);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.filter = "grayscale(1) contrast(180%)";
    context.drawImage(source, x0, y0, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);

    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    for (let offset = 0; offset < pixels.data.length; offset += 4) {
      const ink = pixels.data[offset] < 210 ? 0 : 255;
      pixels.data[offset] = ink;
      pixels.data[offset + 1] = ink;
      pixels.data[offset + 2] = ink;
    }
    context.putImageData(pixels, 0, 0);
    return { canvas, x0, y0, scale };
  }

  #refineCandidate(candidate, data, crop) {
    const words = this.#words(data);
    const units = (words.length ? words : this.#lines(data))
      .filter((unit) => (unit.text.match(/[a-z]/gi) || []).length >= 1 && unit.confidence >= 15)
      .sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);

    if (!units.length) return { ...candidate, refined: true };
    const boxes = units.map((unit) => ({
      x0: crop.x0 + unit.bbox.x0 / crop.scale,
      y0: crop.y0 + unit.bbox.y0 / crop.scale,
      x1: crop.x0 + unit.bbox.x1 / crop.scale,
      y1: crop.y0 + unit.bbox.y1 / crop.scale,
    }));

    return {
      text: units.map((unit) => unit.text.trim()).join(" "),
      confidence: units.reduce((sum, unit) => sum + unit.confidence, 0) / units.length,
      bbox: this.#unionBoxes([candidate.bbox, ...boxes]),
      refined: true,
    };
  }

  #lines(data) {
    if (Array.isArray(data.lines) && data.lines.length) return data.lines;
    return (data.blocks || []).flatMap((block) => (block.paragraphs || []).flatMap((paragraph) => paragraph.lines || []));
  }

  #words(data) {
    if (Array.isArray(data.words) && data.words.length) return data.words;
    return this.#lines(data).flatMap((line) => line.words || []);
  }

  #unionBoxes(boxes) {
    return {
      x0: Math.min(...boxes.map((box) => box.x0)),
      y0: Math.min(...boxes.map((box) => box.y0)),
      x1: Math.max(...boxes.map((box) => box.x1)),
      y1: Math.max(...boxes.map((box) => box.y1)),
    };
  }
}
