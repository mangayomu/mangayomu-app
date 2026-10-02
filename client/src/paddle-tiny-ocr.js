let ocrPromise = null;
let predictionQueue = Promise.resolve();
let predictionGeneration = 0;

/**
 * Initializes the browser-only PP-OCRv6 Tiny model once per app session.
 * Deliberately never dispose this instance: navigating away from Reader must
 * not download and initialize the model again when the reader is reopened.
 */
export function preloadPaddleTinyOcr() {
  if (!ocrPromise) {
    ocrPromise = import("@mangayomu/paddle-tiny-ocr")
      .then(({ createPaddleTinyOcr }) => createPaddleTinyOcr())
      .catch((error) => {
        ocrPromise = null;
        throw error;
      });
  }
  return ocrPromise;
}

/** Returns OCR text lines in the image's original coordinate space.
 *  Each call auto-increments a global generation. Stale queued predictions
 *  (from prior look-ahead calls) skip inference so the current page's OCR
 *  is not delayed behind stale work in the serial queue. */
export function recognizePaddleTinyText(image) {
  const gen = ++predictionGeneration;
  const prediction = predictionQueue.then(async () => {
    if (gen !== predictionGeneration) return [];
    const ocr = await preloadPaddleTinyOcr();
    if (gen !== predictionGeneration) return [];
    const [result] = await ocr.predict(image, { textDetBoxThresh: 0.45 });
    return Array.isArray(result?.items) ? result.items : [];
  });
  // Current-page and ahead-of-time requests share one model instance. Keep
  // inference sequential while allowing a failed page to leave the queue usable.
  predictionQueue = prediction.then(() => undefined, () => undefined);
  return prediction;
}
