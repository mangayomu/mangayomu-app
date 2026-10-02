# @mangayomu/paddle-tiny-ocr

Browser-only PP-OCRv6 Tiny OCR package.

It ships a pre-bundled PaddleOCR runtime, the Tiny detector and recognizer, and the matching ONNX Runtime WASM files. It includes no Paddle Mobile model and makes no runtime network request for Paddle assets.

```js
import { createPaddleTinyOcr } from "@mangayomu/paddle-tiny-ocr";

const ocr = await createPaddleTinyOcr();
const [result] = await ocr.predict(image);
await ocr.dispose();
```

## Output

`result.items` contains one entry for each recognized text line:

```js
{
  poly: [[x1, y1], [x2, y2], [x3, y3], [x4, y4]],
  text: "Recognized text",
  score: 0.96,
}
```

`poly` is the precise four-point bounding box in source-image coordinates. It supports rotated text; derive an axis-aligned rectangle from its minimum and maximum x/y values when an overlay needs `x0`, `y0`, `x1`, and `y1`.
