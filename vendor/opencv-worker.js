/*
 * Runs OpenCV.js off the main thread. The original web build called OpenCV.js
 * synchronously on the page and it froze iPhone Safari, so scan/perspective
 * correction was disabled entirely (see app.js history). Moving the same
 * detection work Android's DocumentDetector does into a Worker keeps the page
 * responsive no matter how long a frame takes to process — mirrors "heavy work
 * never runs on the UI thread" from the native app.
 */
self.cvReady = false;
self.cvReadyPromise = null;

function ensureCvLoaded() {
  if (self.cvReadyPromise) return self.cvReadyPromise;
  self.cvReadyPromise = new Promise((resolve, reject) => {
    try {
      self.cv = undefined;
      importScripts('./opencv.js');
      const cv = self.cv;
      if (cv.getBuildInformation) {
        self.cvReady = true;
        resolve();
        return;
      }
      cv['onRuntimeInitialized'] = () => { self.cvReady = true; resolve(); };
    } catch (error) {
      reject(error);
    }
  });
  return self.cvReadyPromise;
}

self.onmessage = async (event) => {
  const { id, imageData, mode } = event.data;
  try {
    await ensureCvLoaded();
    if (mode === 'detect-only') {
      const result = detectOnly(imageData);
      self.postMessage({ id, ok: true, ...result });
      return;
    }
    const result = mode === 'detect-and-warp' ? detectAndWarp(imageData) : null;
    if (result) {
      self.postMessage({ id, ok: true, ...result }, [result.imageData.data.buffer]);
    } else {
      self.postMessage({ id, ok: true, detected: false });
    }
  } catch (error) {
    self.postMessage({ id, ok: false, error: String(error && error.message || error) });
  }
};

/** Live-preview path: corner points only, no warp — kept cheap enough to run every frame. */
function detectOnly(sourceImageData) {
  const cv = self.cv;
  const src = cv.matFromImageData(sourceImageData);
  const width = src.cols;
  const height = src.rows;
  const corners = findDocumentCorners(cv, src);
  src.delete();
  if (!corners) return { detected: false, width, height };
  return { detected: true, width, height, corners: corners.map((p) => ({ x: p.x, y: p.y })) };
}

function detectAndWarp(sourceImageData) {
  const cv = self.cv;
  const src = cv.matFromImageData(sourceImageData);
  let detectionSrc = src;
  let scale = 1;
  const maxDetectionEdge = 1000;
  const longest = Math.max(src.cols, src.rows);
  if (longest > maxDetectionEdge) {
    scale = maxDetectionEdge / longest;
    detectionSrc = new cv.Mat();
    cv.resize(src, detectionSrc, new cv.Size(Math.round(src.cols * scale), Math.round(src.rows * scale)), 0, 0, cv.INTER_AREA);
  }

  const corners = findDocumentCorners(cv, detectionSrc);
  if (detectionSrc !== src) detectionSrc.delete();

  if (!corners) {
    src.delete();
    return null;
  }

  const fullSizeCorners = corners.map((point) => ({ x: point.x / scale, y: point.y / scale }));
  const warped = warpDocument(cv, src, fullSizeCorners);
  src.delete();

  // warped is still RGBA (matFromImageData produced RGBA and warpPerspective
  // doesn't change channel count), so its own data can back ImageData directly.
  const clamped = new Uint8ClampedArray(warped.data);
  const imageData = new ImageData(clamped, warped.cols, warped.rows);
  warped.delete();
  return { detected: true, imageData, width: imageData.width, height: imageData.height };
}

/** Same scoring as the Android detector: the outer page, never an inner table/box. */
function findDocumentCorners(cv, rgba) {
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const edges = new cv.Mat();
  cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
  cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
  cv.Canny(blurred, edges, 60, 160);
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
  cv.dilate(edges, edges, kernel);

  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

  const imageArea = rgba.cols * rgba.rows;
  let bestArea = 0;
  let best = null;

  for (let i = 0; i < contours.size(); i += 1) {
    const contour = contours.get(i);
    const curve = new cv.Mat();
    contour.convertTo(curve, cv.CV_32FC2);
    const perimeter = cv.arcLength(curve, true);
    const approx = new cv.Mat();
    cv.approxPolyDP(curve, approx, perimeter * 0.02, true);

    if (approx.rows === 4) {
      const points = matToPoints(approx);
      const area = Math.abs(cv.contourArea(approx));
      const bounds = cv.boundingRect(approx);
      const widthCoverage = bounds.width / rgba.cols;
      const heightCoverage = bounds.height / rgba.rows;
      const spansMostOfImage = widthCoverage >= 0.70 && heightCoverage >= 0.70;
      if (area > imageArea * 0.40 && spansMostOfImage && area > bestArea && cv.isContourConvex(approx)) {
        bestArea = area;
        best = orderCorners(points);
      }
    }
    curve.delete();
    approx.delete();
    contour.delete();
  }

  kernel.delete();
  hierarchy.delete();
  contours.delete();
  edges.delete();
  blurred.delete();
  gray.delete();
  return best;
}

function matToPoints(mat) {
  const points = [];
  for (let row = 0; row < mat.rows; row += 1) {
    points.push({ x: mat.data32F[row * 2], y: mat.data32F[row * 2 + 1] });
  }
  return points;
}

/** Returns [topLeft, topRight, bottomRight, bottomLeft]. */
function orderCorners(points) {
  let topLeft = null, topRight = null, bottomRight = null, bottomLeft = null;
  let minSum = Infinity, maxSum = -Infinity, minDiff = Infinity, maxDiff = -Infinity;
  for (const point of points) {
    const sum = point.x + point.y;
    const diff = point.y - point.x;
    if (sum < minSum) { minSum = sum; topLeft = point; }
    if (sum > maxSum) { maxSum = sum; bottomRight = point; }
    if (diff < minDiff) { minDiff = diff; topRight = point; }
    if (diff > maxDiff) { maxDiff = diff; bottomLeft = point; }
  }
  if (!topLeft || !topRight || !bottomRight || !bottomLeft) return null;
  return [topLeft, topRight, bottomRight, bottomLeft];
}

function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

function warpDocument(cv, source, corners) {
  const top = distance(corners[0], corners[1]);
  const bottom = distance(corners[3], corners[2]);
  const left = distance(corners[0], corners[3]);
  const right = distance(corners[1], corners[2]);
  const width = Math.max(600, Math.round(Math.max(top, bottom)));
  const height = Math.max(600, Math.round(Math.max(left, right)));

  const sourcePoints = cv.matFromArray(4, 1, cv.CV_32FC2, [
    corners[0].x, corners[0].y, corners[1].x, corners[1].y,
    corners[2].x, corners[2].y, corners[3].x, corners[3].y
  ]);
  const destinationPoints = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0, 0, width - 1, 0, width - 1, height - 1, 0, height - 1
  ]);
  const transform = cv.getPerspectiveTransform(sourcePoints, destinationPoints);
  const output = new cv.Mat();
  cv.warpPerspective(source, output, transform, new cv.Size(width, height), cv.INTER_CUBIC, cv.BORDER_CONSTANT, new cv.Scalar());
  sourcePoints.delete();
  destinationPoints.delete();
  transform.delete();
  return output;
}
