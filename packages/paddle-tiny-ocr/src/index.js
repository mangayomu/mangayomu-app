import { PaddleOCR, initOpenCvRuntime, loadOrtModule } from "../vendor/paddleocr.mjs";

export const PADDLE_TINY_MODEL_LABEL = "PP-OCRv6 Tiny";

const detectionModelUrl = new URL("../assets/models/PP-OCRv6_tiny_det_onnx_infer.tar", import.meta.url).href;
const recognitionModelUrl = new URL("../assets/models/PP-OCRv6_tiny_rec_onnx_infer.tar", import.meta.url).href;
// Keep exact URLs so Vite can hash the assets while ONNX Runtime still loads them.
const ortLoaderUrl = new URL("../assets/onnxruntime/ort-wasm-simd-threaded.jsep.mjs", import.meta.url).href;
const ortWasmUrl = new URL("../assets/onnxruntime/ort-wasm-simd-threaded.jsep.wasm", import.meta.url).href;

/**
 * Creates a browser-only PP-OCRv6 Tiny pipeline using only files shipped by
 * this package. The Tiny detector/recognizer and matching ONNX Runtime assets
 * are deliberately local; no Mobile model is included.
 */
/**
 * Reuses the OpenCV.js runtime already bundled for Paddle preprocessing.
 * Consumers can run lightweight classical CV experiments without shipping a
 * second OpenCV payload.
 */
export function getPaddleTinyOpenCv() {
  return initOpenCvRuntime();
}

/** Reuses the package's local ONNX Runtime and WASM assets. */
export async function getPaddleTinyOnnxRuntime() {
  const ort = await loadOrtModule();
  ort.env.wasm.wasmPaths = { mjs: ortLoaderUrl, wasm: ortWasmUrl };
  ort.env.wasm.numThreads = 1;
  return ort;
}

export function createPaddleTinyOcr({ ortOptions = {} } = {}) {
  return PaddleOCR.create({
    textDetectionModelName: "PP-OCRv6_tiny_det",
    textDetectionModelAsset: { url: detectionModelUrl },
    textRecognitionModelName: "PP-OCRv6_tiny_rec",
    textRecognitionModelAsset: { url: recognitionModelUrl },
    // Paddle's worker transport owns model initialization and inference in a
    // dedicated Web Worker. Calls are still serialized by the Reader client.
    worker: true,
    ortOptions: {
      backend: "wasm",
      wasmPaths: { mjs: ortLoaderUrl, wasm: ortWasmUrl },
      numThreads: 1,
      ...ortOptions,
    },
  });
}
