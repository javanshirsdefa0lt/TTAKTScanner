/* TTAKTScanner Web — all scan and OCR work is performed in this browser. */
(() => {
  'use strict';

  const MAX_SOURCE_EDGE = 2300;
  // This is an OCR-only working copy. The colour JPG/PDF preview always keeps
  // the original scan canvas.
  const RECEIPT_OCR_MAX_EDGE = 1600;
  const RECEIPT_ROW_UPSCALE = 8;

  const el = {
    cameraInput: document.querySelector('#cameraInput'),
    fileInput: document.querySelector('#fileInput'),
    cameraButton: document.querySelector('#cameraButton'),
    fileButton: document.querySelector('#fileButton'),
    modeButtons: [...document.querySelectorAll('.mode-button')],
    modeCopy: document.querySelector('#modeCopy'),
    modeDescription: document.querySelector('#modeDescription'),
    previewArea: document.querySelector('#previewArea'),
    previewCanvas: document.querySelector('#previewCanvas'),
    previewControls: document.querySelector('#previewControls'),
    pageStrip: document.querySelector('#pageStrip'),
    scanStatus: document.querySelector('#scanStatus'),
    scanDetail: document.querySelector('#scanDetail'),
    codeLabel: document.querySelector('#codeLabel'),
    fieldHelp: document.querySelector('#fieldHelp'),
    codeField: document.querySelector('#codeField'),
    pageCount: document.querySelector('#pageCount'),
    workingState: document.querySelector('#workingState'),
    workingText: document.querySelector('#workingText'),
    rotateLeft: document.querySelector('#rotateLeft'),
    rotateRight: document.querySelector('#rotateRight'),
    addPage: document.querySelector('#addPage'),
    saveJpg: document.querySelector('#saveJpg'),
    savePdf: document.querySelector('#savePdf'),
    shareWhatsapp: document.querySelector('#shareWhatsapp'),
    resetScan: document.querySelector('#resetScan'),
    cameraOverlay: document.querySelector('#cameraOverlay'),
    cameraVideo: document.querySelector('#cameraVideo'),
    cameraGuide: document.querySelector('#cameraGuide'),
    cameraClose: document.querySelector('#cameraClose'),
    cameraFlash: document.querySelector('#cameraFlash'),
    cameraHint: document.querySelector('#cameraHint'),
    cameraShutter: document.querySelector('#cameraShutter')
  };

  const state = {
    mode: 'delivery',
    sessions: { delivery: createSession(), container: createSession() },
    worker: null,
    workerPromise: null,
    ocrQueue: Promise.resolve(),
    processing: 0,
    cvWorker: null,
    cvPending: new Map(),
    cvNextId: 1,
    cameraStream: null,
    cameraModeAtOpen: null,
    cameraAnalyzing: false,
    cameraCapturing: false,
    cameraRafId: null,
    cameraLastRun: 0,
    cameraStability: null,
    cameraTorchTrack: null,
    cameraTorchOn: false
  };

  function createSession() {
    return { pages: [], activeIndex: -1, code: '', generation: 0, lastDetail: '' };
  }

  function currentSession() { return state.sessions[state.mode]; }

  function copyFor(mode) {
    return mode === 'container'
      ? {
          eyebrow: 'KONTEYNER AKTI',
          title: 'Qəbz nömrələrini tap',
          description: '“Qəbz” sütununun altındakı nömrələr WhatsApp üçün alt-alta hazırlanacaq.',
          label: 'QƏBZ NÖMRƏLƏRİ',
          help: 'Hər qəbz nömrəsi ayrı sətirdədir. Göndərməzdən əvvəl redaktə edə bilərsiniz.',
          shareTitle: 'Qəbz nömrələri №'
        }
      : {
          eyebrow: 'TƏHVİL-TƏSLİM AKTI',
          title: 'Faktura kodunu tap',
          description: '“nömrəli fakturaya əsasən” ifadəsindən əvvəlki rəqəmlər birləşdiriləcək.',
          label: 'FAKTURA KODU',
          help: 'OCR nəticəsini göndərməzdən əvvəl yoxlayın.',
          shareTitle: 'Faktura №'
        };
  }

  function initialize() {
    el.modeButtons.forEach((button) => button.addEventListener('click', () => switchMode(button.dataset.mode)));
    el.cameraInput.addEventListener('change', onFileChosen);
    el.fileInput.addEventListener('change', onFileChosen);
    el.cameraButton.addEventListener('click', () => openCamera());
    el.fileButton.addEventListener('click', () => el.fileInput.click());
    el.codeField.addEventListener('input', () => { currentSession().code = el.codeField.value; });
    el.rotateLeft.addEventListener('click', () => rotateActivePage(-90));
    el.rotateRight.addEventListener('click', () => rotateActivePage(90));
    el.addPage.addEventListener('click', () => openCamera());
    el.cameraClose.addEventListener('click', () => closeCamera());
    el.cameraShutter.addEventListener('click', () => manualCapture());
    el.cameraFlash.addEventListener('click', () => toggleTorch());
    el.saveJpg.addEventListener('click', saveAllAsJpg);
    el.savePdf.addEventListener('click', saveAllAsPdf);
    el.shareWhatsapp.addEventListener('click', shareOnWhatsapp);
    el.resetScan.addEventListener('click', resetCurrentScan);
    render();
    // Start the local model while the user is framing the document.  It keeps
    // the first tap-to-scan path short without sending the photo anywhere.
    window.setTimeout(() => { getOcrWorker().catch(() => undefined); }, 120);
    // Same idea for the ~10MB OpenCV.js WASM bundle: load it in its Worker now
    // so the first Auto Scan doesn't pay that cost.
    window.setTimeout(() => { try { getCvWorker(); } catch (_) { /* falls back per-scan */ } }, 200);
  }

  function switchMode(mode) {
    if (mode === state.mode || (mode !== 'delivery' && mode !== 'container')) return;
    state.mode = mode;
    render();
  }

  function render() {
    const session = currentSession();
    const copy = copyFor(state.mode);
    el.modeButtons.forEach((button) => {
      const active = button.dataset.mode === state.mode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    });
    el.modeCopy.querySelector('.section-label').textContent = copy.eyebrow;
    el.modeCopy.querySelector('h3').textContent = copy.title;
    el.modeDescription.textContent = copy.description;
    el.codeLabel.textContent = copy.label;
    el.fieldHelp.textContent = copy.help;
    el.codeField.value = session.code;
    el.codeField.classList.toggle('multiline', state.mode === 'container');
    el.codeField.rows = state.mode === 'container' ? 5 : 1;
    el.codeField.setAttribute('aria-label', copy.label);
    el.pageCount.textContent = `${session.pages.length} səhifə`;
    el.previewControls.hidden = session.pages.length === 0;
    const enabled = session.pages.length > 0 && state.processing === 0;
    [el.saveJpg, el.savePdf, el.shareWhatsapp].forEach((button) => { button.disabled = !enabled; });
    // Sıfırlama OCR davam edərkən də mümkündür; generation yoxlaması köhnə
    // nəticənin yeni sənədə sonradan yazılmasına mane olur.
    el.resetScan.disabled = session.pages.length === 0;
    renderPreview();
    renderPageStrip();
  }

  function renderPreview() {
    const session = currentSession();
    const page = session.pages[session.activeIndex];
    if (!page) {
      el.previewArea.classList.remove('ready');
      return;
    }
    el.previewCanvas.width = page.scanCanvas.width;
    el.previewCanvas.height = page.scanCanvas.height;
    el.previewCanvas.getContext('2d', { alpha: false }).drawImage(page.scanCanvas, 0, 0);
    el.previewArea.classList.add('ready');
    el.scanStatus.textContent = page.detected ? 'Sənəd kənarları tapıldı, perspektiv düzəldildi.' : 'Sənədin tam rəngli şəkli scan kimi hazırlandı.';
    el.scanDetail.textContent = session.lastDetail || 'Scan rəngləri qoruyur; şəkil qara-ağ formata çevrilmir.';
  }

  function renderPageStrip() {
    const session = currentSession();
    el.pageStrip.replaceChildren();
    session.pages.forEach((page, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `page-thumb${index === session.activeIndex ? ' active' : ''}`;
      button.setAttribute('aria-label', `${index + 1}-ci səhifəni göstər`);
      const image = document.createElement('img');
      image.src = page.scanCanvas.toDataURL('image/jpeg', .75);
      image.alt = '';
      const number = document.createElement('span');
      number.textContent = index + 1;
      button.append(image, number);
      button.addEventListener('click', () => { session.activeIndex = index; render(); });
      el.pageStrip.append(button);
    });
  }

  async function onFileChosen(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !file.type.startsWith('image/')) return;
    const modeAtStart = state.mode;
    try {
      const sourceCanvas = await imageFileToCanvas(file);
      await acceptSourceCanvas(sourceCanvas, modeAtStart);
    } catch (error) {
      if (state.mode === modeAtStart) {
        el.scanStatus.textContent = 'Scan hazırlana bilmədi. Şəkli yenidən çəkin.';
        el.scanDetail.textContent = error?.message || 'Naməlum xəta.';
      }
    }
  }

  /** Shared by the file picker and the live camera capture path below. */
  async function acceptSourceCanvas(sourceCanvas, modeAtStart) {
    const session = state.sessions[modeAtStart];
    const generation = session.generation;
    setWorking(true, 'Rəngli scan hazırlanır…', modeAtStart);
    try {
      // OpenCV now runs in a Worker (vendor/opencv-worker.js) instead of on
      // this thread, so the page never freezes the way the old synchronous
      // call did on iPhone Safari; a slow/failed detection just falls back
      // to the full-colour original instead of blocking the UI.
      const detection = await scanWithAutoDetect(sourceCanvas);
      const scan = detection.detected
        ? { canvas: imageDataToCanvas(detection.imageData), detected: true }
        : { canvas: cloneCanvas(sourceCanvas), detected: false };
      if (generation !== session.generation) return;
      session.pages.push({ sourceCanvas, scanCanvas: scan.canvas, detected: scan.detected });
      session.activeIndex = session.pages.length - 1;
      session.lastDetail = scan.detected
        ? 'Rəngli görünüş saxlanıldı; yalnız sənədin kənarları və perspektiv düzəldildi.'
        : 'Kənarlar dəqiq seçilmədi. Orijinal rəngli şəkil saxlanıldı.';
      if (state.mode === modeAtStart) render();
      queueOcr(session.pages.at(-1), modeAtStart, session, generation);
    } catch (error) {
      if (generation === session.generation && state.mode === modeAtStart) {
        el.scanStatus.textContent = 'Scan hazırlana bilmədi. Şəkli yenidən çəkin.';
        el.scanDetail.textContent = error?.message || 'Naməlum xəta.';
      }
    } finally {
      setWorking(false, '', modeAtStart);
    }
  }

  function setWorking(isWorking, text, mode) {
    state.processing += isWorking ? 1 : -1;
    state.processing = Math.max(0, state.processing);
    if (state.mode === mode) {
      el.workingState.hidden = state.processing === 0;
      if (text) el.workingText.textContent = text;
      render();
    } else if (state.processing === 0) render();
  }

  async function imageFileToCanvas(file) {
    const bitmap = await decodeImage(file);
    const biggest = Math.max(bitmap.width, bitmap.height);
    const scale = Math.min(1, MAX_SOURCE_EDGE / biggest);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d', { alpha: false }).drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    return canvas;
  }

  async function decodeImage(file) {
    if ('createImageBitmap' in window) {
      try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (_) { return createImageBitmap(file); }
    }
    const url = URL.createObjectURL(file);
    try {
      const image = await new Promise((resolve, reject) => {
        const element = new Image();
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error('Şəkil açıla bilmədi.'));
        element.src = url;
      });
      return image;
    } finally { URL.revokeObjectURL(url); }
  }

  function cloneCanvas(source) {
    const clone = document.createElement('canvas');
    clone.width = source.width;
    clone.height = source.height;
    clone.getContext('2d', { alpha: false }).drawImage(source, 0, 0);
    return clone;
  }

  // ---- Auto Scan: outer-contour detection + perspective correction ---------
  // Runs entirely in vendor/opencv-worker.js. A crashed/unavailable worker or
  // a detection that takes too long both resolve to {detected:false}, so the
  // caller always falls back to the untouched colour original — Auto Scan is
  // an enhancement here, never a hard requirement to produce a scan at all.

  function getCvWorker() {
    if (!state.cvWorker) {
      state.cvWorker = new Worker(new URL('./vendor/opencv-worker.js', document.baseURI).href);
      state.cvWorker.onmessage = (event) => {
        const pending = state.cvPending.get(event.data.id);
        if (!pending) return;
        state.cvPending.delete(event.data.id);
        pending(event.data);
      };
      state.cvWorker.onerror = () => {
        // A malformed message can't be matched to a pending id; fail every
        // outstanding request rather than leaving callers waiting forever.
        for (const resolve of state.cvPending.values()) resolve({ ok: false });
        state.cvPending.clear();
      };
    }
    return state.cvWorker;
  }

  function scanWithAutoDetect(sourceCanvas, timeoutMs = 7000) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      try {
        const worker = getCvWorker();
        const id = state.cvNextId += 1;
        const context = sourceCanvas.getContext('2d', { alpha: false, willReadFrequently: true });
        const imageData = context.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
        const timer = setTimeout(() => {
          state.cvPending.delete(id);
          finish({ detected: false });
        }, timeoutMs);
        state.cvPending.set(id, (data) => {
          clearTimeout(timer);
          finish(data.ok && data.detected ? data : { detected: false });
        });
        worker.postMessage({ id, mode: 'detect-and-warp', imageData }, [imageData.data.buffer]);
      } catch (_) {
        finish({ detected: false });
      }
    });
  }

  function imageDataToCanvas(imageData) {
    const canvas = document.createElement('canvas');
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    canvas.getContext('2d', { alpha: false }).putImageData(imageData, 0, 0);
    return canvas;
  }

  // ---- Live camera: getUserMedia preview + Auto Scan overlay ---------------
  // Mirrors the native app's ScanCameraActivity: a live feed with a corner
  // overlay, auto-capture once the same page holds steady for several
  // consecutive frames, and a manual shutter that always works regardless.
  // Falls back to the OS camera app (the existing file-input path) if
  // getUserMedia isn't available or permission is refused — the user is
  // never left without a way to take the photo.

  const CAMERA_ANALYSIS_INTERVAL_MS = 260;
  const CAMERA_REQUIRED_STABLE_FRAMES = 5;
  const CAMERA_MAX_CORNER_DRIFT_FRACTION = 0.02;
  const CAMERA_DETECTION_MAX_EDGE = 640;
  const CAMERA_CAPTURE_MAX_EDGE = MAX_SOURCE_EDGE;

  async function openCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      el.cameraInput.click();
      return;
    }
    state.cameraModeAtOpen = state.mode;
    showCameraOverlay(true);
    el.cameraHint.textContent = 'Sənədi kadra tam yerləşdirin';
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false
      });
      state.cameraStream = stream;
      el.cameraVideo.srcObject = stream;
      await el.cameraVideo.play().catch(() => undefined);
      setupTorch(stream);
      state.cameraStability = { lastCorners: null, streak: 0 };
      state.cameraRafId = requestAnimationFrame(cameraLoop);
    } catch (_) {
      // Permission denied, no camera, insecure context, etc. — the file
      // input (with capture="environment") is still a working path in.
      closeCamera();
      el.cameraInput.click();
    }
  }

  function showCameraOverlay(visible) {
    el.cameraOverlay.classList.toggle('active', visible);
    el.cameraOverlay.setAttribute('aria-hidden', String(!visible));
  }

  function closeCamera() {
    showCameraOverlay(false);
    if (state.cameraRafId) cancelAnimationFrame(state.cameraRafId);
    state.cameraRafId = null;
    state.cameraAnalyzing = false;
    state.cameraCapturing = false;
    state.cameraStability = null;
    if (state.cameraStream) {
      state.cameraStream.getTracks().forEach((track) => track.stop());
      state.cameraStream = null;
    }
    el.cameraVideo.srcObject = null;
    el.cameraFlash.hidden = true;
    state.cameraTorchTrack = null;
    state.cameraTorchOn = false;
  }

  function setupTorch(stream) {
    const track = stream.getVideoTracks()[0];
    const capabilities = track.getCapabilities ? track.getCapabilities() : {};
    if (!capabilities.torch) {
      el.cameraFlash.hidden = true;
      return;
    }
    state.cameraTorchTrack = track;
    state.cameraTorchOn = false;
    el.cameraFlash.hidden = false;
  }

  function toggleTorch() {
    if (!state.cameraTorchTrack) return;
    state.cameraTorchOn = !state.cameraTorchOn;
    state.cameraTorchTrack.applyConstraints({ advanced: [{ torch: state.cameraTorchOn }] }).catch(() => undefined);
  }

  function cameraLoop(timestamp) {
    if (!state.cameraStream) return; // camera was closed
    state.cameraRafId = requestAnimationFrame(cameraLoop);
    if (state.cameraAnalyzing || state.cameraCapturing) return;
    if (timestamp - state.cameraLastRun < CAMERA_ANALYSIS_INTERVAL_MS) return;
    state.cameraLastRun = timestamp;
    analyzeCameraFrame();
  }

  async function analyzeCameraFrame() {
    const video = el.cameraVideo;
    if (!video.videoWidth || !video.videoHeight) return;
    state.cameraAnalyzing = true;
    try {
      const scale = Math.min(1, CAMERA_DETECTION_MAX_EDGE / Math.max(video.videoWidth, video.videoHeight));
      const w = Math.max(1, Math.round(video.videoWidth * scale));
      const h = Math.max(1, Math.round(video.videoHeight * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
      context.drawImage(video, 0, 0, w, h);
      const imageData = context.getImageData(0, 0, w, h);
      const result = await cvDetectOnly(imageData);
      if (!state.cameraStream) return; // closed while awaiting the worker
      const status = updateCameraStability(result);
      drawCameraGuide(result, status);
      updateCameraHint(status);
      if (status === 'ready' && !state.cameraCapturing) autoCapture();
    } catch (_) {
      // A single bad frame must never stop the live loop.
    } finally {
      state.cameraAnalyzing = false;
    }
  }

  function cvDetectOnly(imageData) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
      try {
        const worker = getCvWorker();
        const id = state.cvNextId += 1;
        const timer = setTimeout(() => { state.cvPending.delete(id); finish({ detected: false }); }, 1500);
        state.cvPending.set(id, (data) => {
          clearTimeout(timer);
          finish(data.ok ? data : { detected: false });
        });
        worker.postMessage({ id, mode: 'detect-only', imageData });
      } catch (_) {
        finish({ detected: false });
      }
    });
  }

  function updateCameraStability(result) {
    const tracker = state.cameraStability;
    if (!tracker) return 'searching';
    if (!result.detected || !result.corners) {
      tracker.lastCorners = null;
      tracker.streak = 0;
      tracker.lastResult = result;
      return 'searching';
    }
    const stable = tracker.lastCorners && isCornerSetStable(tracker.lastCorners, result.corners, result.width, result.height);
    tracker.streak = stable ? tracker.streak + 1 : 1;
    tracker.lastCorners = result.corners;
    tracker.lastResult = result;
    return tracker.streak >= CAMERA_REQUIRED_STABLE_FRAMES ? 'ready' : 'detected';
  }

  function isCornerSetStable(a, b, width, height) {
    const diagonal = Math.hypot(width, height);
    const maxAllowed = diagonal * CAMERA_MAX_CORNER_DRIFT_FRACTION;
    for (let i = 0; i < 4; i += 1) {
      if (Math.hypot(a[i].x - b[i].x, a[i].y - b[i].y) > maxAllowed) return false;
    }
    return true;
  }

  function updateCameraHint(status) {
    if (state.cameraCapturing) return;
    if (status === 'ready') el.cameraHint.textContent = 'Hazırdır — çəkilir';
    else if (status === 'detected') el.cameraHint.textContent = 'Sənəd tapıldı, sabitlənir…';
    else el.cameraHint.textContent = 'Sənədi kadra tam yerləşdirin';
  }

  /** Draws the tracked quad (object-fit:cover-aware) or a static search hint. */
  function drawCameraGuide(result, status) {
    const canvas = el.cameraGuide;
    const box = el.cameraVideo.getBoundingClientRect();
    if (canvas.width !== box.width || canvas.height !== box.height) {
      canvas.width = box.width;
      canvas.height = box.height;
    }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const accent = status === 'ready' ? '#E31E24' : 'rgba(255,255,255,0.92)';

    if (!result.detected || !result.corners) {
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 2;
      ctx.setLineDash([10, 8]);
      const mx = canvas.width * 0.10, my = canvas.height * 0.18;
      roundRectPath(ctx, mx, my, canvas.width - 2 * mx, canvas.height - 2 * my, 18);
      ctx.stroke();
      ctx.setLineDash([]);
      return;
    }

    const mapped = result.corners.map((point) =>
      mapDetectionPointToCoverBox(point, result.width, result.height, canvas.width, canvas.height));
    ctx.beginPath();
    mapped.forEach((point, index) => (index === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y)));
    ctx.closePath();
    ctx.fillStyle = status === 'ready' ? 'rgba(227,30,36,0.16)' : 'rgba(255,255,255,0.10)';
    ctx.fill();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2.5;
    ctx.stroke();

    ctx.strokeStyle = accent;
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    const bracket = 22;
    mapped.forEach((point) => {
      ctx.beginPath();
      ctx.moveTo(point.x - bracket / 2, point.y);
      ctx.lineTo(point.x + bracket / 2, point.y);
      ctx.moveTo(point.x, point.y - bracket / 2);
      ctx.lineTo(point.x, point.y + bracket / 2);
      ctx.stroke();
    });
  }

  /** Video is shown with CSS object-fit:cover; maps a detection-frame point into that box exactly. */
  function mapDetectionPointToCoverBox(point, detectionWidth, detectionHeight, boxWidth, boxHeight) {
    const videoAspect = detectionWidth / detectionHeight;
    const boxAspect = boxWidth / boxHeight;
    let scale, offsetX = 0, offsetY = 0;
    if (videoAspect > boxAspect) {
      scale = boxHeight / detectionHeight;
      offsetX = (detectionWidth * scale - boxWidth) / 2;
    } else {
      scale = boxWidth / detectionWidth;
      offsetY = (detectionHeight * scale - boxHeight) / 2;
    }
    return { x: point.x * scale - offsetX, y: point.y * scale - offsetY };
  }

  function roundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function autoCapture() {
    state.cameraCapturing = true;
    el.cameraHint.textContent = 'Şəkil hazırlanır…';
    captureCurrentFrame();
  }

  function manualCapture() {
    if (!state.cameraStream || state.cameraCapturing) return;
    state.cameraCapturing = true;
    el.cameraHint.textContent = 'Şəkil hazırlanır…';
    captureCurrentFrame();
  }

  async function captureCurrentFrame() {
    const video = el.cameraVideo;
    const modeAtCapture = state.cameraModeAtOpen;
    try {
      const scale = Math.min(1, CAMERA_CAPTURE_MAX_EDGE / Math.max(video.videoWidth, video.videoHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      canvas.getContext('2d', { alpha: false }).drawImage(video, 0, 0, canvas.width, canvas.height);
      closeCamera();
      await acceptSourceCanvas(canvas, modeAtCapture);
    } catch (_) {
      closeCamera();
    }
  }

  function queueOcr(page, mode, session, generation) {
    state.ocrQueue = state.ocrQueue.catch(() => undefined).then(() => runOcr(page, mode, session, generation));
  }

  async function runOcr(page, mode, session, generation) {
    if (generation !== session.generation) return;
    if (state.mode === mode) setWorking(true, mode === 'container' ? 'Qəbz nömrələri oxunur…' : 'Faktura kodu oxunur…', mode);
    try {
      const worker = await getOcrWorker();
      let result = null;
      // These forms are normally photographed in the orientations below.  It
      // makes the common case a single local OCR pass; the remaining turns are
      // still retained as a safe fallback for any rotated photo.
      const orientationOrder = mode === 'container'
        ? [0, 270, 90, 180]
        : [270, 0, 90, 180];
      for (const degrees of orientationOrder) {
        if (generation !== session.generation) return;
        const source = degrees === 0 ? page.sourceCanvas : rotateCanvas(page.sourceCanvas, degrees);
        const receiptOcrCanvas = mode === 'container' ? prepareReceiptOcrCanvas(source) : null;
        const recognition = mode === 'container'
          ? await worker.recognize(receiptOcrCanvas, { tessedit_pageseg_mode: '11' })
          : await worker.recognize(source);
        const found = mode === 'container'
          ? await findReceiptNumbersWithColumnPass(worker, source, receiptOcrCanvas, recognition.data)
          : findInvoiceNumber(recognition.data);
        if (mode === 'container' ? found.length > 0 : Boolean(found)) { result = found; break; }
      }
      if (generation !== session.generation) return;
      if (mode === 'container') {
        if (result?.length) {
          const existing = session.code.trim();
          session.code = `${existing}${existing ? '\n' : ''}${result.join('\n')}`;
          session.lastDetail = `${result.length} qəbz nömrəsi tapıldı. WhatsApp-da alt-alta yazılacaq.`;
        } else session.lastDetail = 'Qəbz sütunu tapılmadı. Nömrələri aşağıdakı xanaya əl ilə yaza bilərsiniz.';
      } else if (result) {
        session.code = result;
        session.lastDetail = 'Faktura kodu tapıldı. Göndərməzdən əvvəl yoxlayın.';
      } else session.lastDetail = 'Faktura kodu tapılmadı. Şəkli daha yaxın və işıqlı çəkin.';
      if (state.mode === mode) render();
    } catch (error) {
      if (generation === session.generation) {
        session.lastDetail = 'Lokal OCR hazırda oxuya bilmədi. Kodu əl ilə yaza bilərsiniz.';
        if (state.mode === mode) render();
      }
    } finally {
      if (state.mode === mode) setWorking(false, '', mode);
    }
  }

  async function getOcrWorker() {
    if (state.worker) return state.worker;
    if (!state.workerPromise) {
      if (!window.Tesseract) throw new Error('OCR modulu yüklənmədi.');
      // Absolute URLs: the worker's own importScripts() resolves relative
      // paths against ITS location (/vendor/), not the page's, so a relative
      // './vendor/...' here doubled up into '/vendor/vendor/...' and 404'd.
      state.workerPromise = window.Tesseract.createWorker('eng', 1, {
        workerPath: new URL('./vendor/worker.min.js', document.baseURI).href,
        corePath: new URL('./vendor/tesseract-core.wasm.js', document.baseURI).href,
        langPath: new URL('./vendor/tessdata', document.baseURI).href,
        cacheMethod: 'write',
        cachePath: 'ttakt-ocr-v3',
        workerBlobURL: false
      }).then((worker) => { state.worker = worker; return worker; }).catch((error) => {
        // A failed first initialization must not poison every later scan.
        state.worker = null;
        state.workerPromise = null;
        throw error;
      });
    }
    return state.workerPromise;
  }

  function rotateCanvas(source, degrees) {
    const sideways = Math.abs(degrees) % 180 === 90;
    const canvas = document.createElement('canvas');
    canvas.width = sideways ? source.height : source.width;
    canvas.height = sideways ? source.width : source.height;
    const context = canvas.getContext('2d', { alpha: false });
    context.translate(canvas.width / 2, canvas.height / 2);
    context.rotate(degrees * Math.PI / 180);
    context.drawImage(source, -source.width / 2, -source.height / 2);
    return canvas;
  }

  function prepareReceiptOcrCanvas(source) {
    const biggest = Math.max(source.width, source.height);
    const scale = Math.min(1.5, RECEIPT_OCR_MAX_EDGE / biggest);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(source.width * scale));
    canvas.height = Math.max(1, Math.round(source.height * scale));
    const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    applyOcrContrast(context, canvas.width, canvas.height, 1.75, 150);
    return canvas;
  }

  function applyOcrContrast(context, width, height, contrast, midpoint) {
    const image = context.getImageData(0, 0, width, height);
    for (let index = 0; index < image.data.length; index += 4) {
      const luminance = image.data[index] * .299 + image.data[index + 1] * .587 + image.data[index + 2] * .114;
      const value = Math.max(0, Math.min(255, (luminance - 128) * contrast + midpoint));
      image.data[index] = value;
      image.data[index + 1] = value;
      image.data[index + 2] = value;
    }
    context.putImageData(image, 0, 0);
  }

  async function findReceiptNumbersWithColumnPass(worker, source, receiptOcrCanvas, data) {
    const { headers, numbers } = receiptHeaderCandidates(data);
    if (!headers.length) return [];

    let best = [];
    // The real Qebz header yields the longest contiguous set directly below it.
    for (const header of headers.slice(0, 2)) {
      const rows = receiptRowsForHeader(header, numbers);
      // Re-OCR each cell at its own measured position with a digit-only
      // whitelist — more accurate than the full-page pass. A fixed row-pitch
      // estimate is only used when the full-page pass found no rows at all,
      // since that estimate drifts whenever a document's real line spacing
      // doesn't match the fixed multiplier it assumes.
      const refined = rows.length
        ? await refineReceiptRows(worker, source, receiptOcrCanvas, rows)
        : await readReceiptColumn(worker, source, receiptOcrCanvas, header);
      if (refined.length > best.length) best = refined;
    }
    return best;
  }

  async function refineReceiptRows(worker, source, receiptOcrCanvas, rows) {
    const scaleX = source.width / receiptOcrCanvas.width;
    const scaleY = source.height / receiptOcrCanvas.height;
    const values = [];
    for (const row of rows) {
      const left = Math.max(0, Math.round((row.left - row.width * .3) * scaleX));
      const width = Math.min(source.width - left, Math.max(1, Math.round(row.width * 1.6 * scaleX)));
      const height = Math.max(1, Math.round(row.height * 1.8 * scaleY));
      const top = Math.max(0, Math.round((row.centerY - row.height * 0.9) * scaleY));
      const xShift = Math.max(1, Math.round(width * .03));
      const yShift = Math.max(1, Math.round(height * .13));
      const refinedValue = await readReceiptRow(worker, source, left, top, width, height, xShift, yShift);
      values.push(pickReceiptValue(row.value, refinedValue));
    }
    return values;
  }

  // The full-page value already passed this table's row/column geometry
  // checks (receiptRowsForHeader), so on a clean crop it isn't automatically
  // less trustworthy than the digit-only single-line re-OCR — testing found
  // the latter can still misread a digit (e.g. 5 as 9) the full-page pass
  // got right, and a longer-but-wrong re-OCR reading (extra/garbled digits
  // from a slightly misjudged crop) must not win just for being longer. The
  // re-OCR's real job is rescuing rows the full-page pass missed entirely or
  // read as letters, so it only overrides the full-page value when it
  // strictly extends it — same digits plus more at one edge — which is what
  // an undersized full-page crop looks like, as opposed to a mismatch.
  function pickReceiptValue(pageValue, refinedValue) {
    if (!refinedValue) return pageValue || null;
    if (!pageValue) return refinedValue;
    if (pageValue === refinedValue) return pageValue;
    if (refinedValue.length > pageValue.length && refinedValue.includes(pageValue)) return refinedValue;
    return pageValue;
  }

  async function readReceiptColumn(worker, source, receiptOcrCanvas, header) {
    if (!header?.width || !header?.height) return [];
    const scaleX = source.width / receiptOcrCanvas.width;
    const scaleY = source.height / receiptOcrCanvas.height;
    // Exclude the table border and marker line while retaining the entire
    // printed number cell.  The top starts a little above the first baseline:
    // it avoids cutting off upper digits on photographed forms.
    const left = Math.max(0, Math.round((header.left - header.width * .68) * scaleX));
    const width = Math.min(source.width - left, Math.max(1, Math.round(header.width * 3 * scaleX)));
    const rowHeight = Math.max(1, Math.round(header.height * 2.25 * scaleY));
    const startTop = Math.max(0, Math.round((header.top + header.height * 1.1) * scaleY));
    const rowPitch = Math.max(rowHeight, Math.round(header.height * 2.45 * scaleY));
    const maxRows = Math.min(20, Math.floor((source.height - startTop) / rowPitch));
    const xShift = Math.max(1, Math.round(width * .03));
    const yShift = Math.max(1, Math.round(rowHeight * .13));
    const values = [];
    let emptyRows = 0;

    for (let row = 0; row < maxRows && emptyRows < 2; row += 1) {
      const top = startTop + row * rowPitch;
      const value = await readReceiptRow(worker, source, left, top, width, rowHeight, xShift, yShift);
      if (value && isReceiptValueConsistent(value, values)) {
        values.push(value);
        emptyRows = 0;
      } else {
        emptyRows += 1;
        // Receipt rows in this column are contiguous.  Once real rows have
        // been read, the first blank is the end of this table run; stopping
        // here prevents lower stamp/plomb digits being treated as receipts.
        if (values.length >= 2) break;
      }
    }
    return values;
  }

  async function readReceiptRow(worker, source, left, top, width, height, xShift, yShift) {
    // Small shifts protect against table borders, shadows and marker strokes.
    // [0,0] and [xShift,0] share the same vertical offset, so when the row
    // crop clips a digit's edge both can misread it the same way — two
    // matching reads used to be accepted as "confirmed" even though they
    // shared the exact same clipping error. All offsets are collected instead
    // and the value most of them agree on wins; a clear unshifted read with
    // very high confidence still short-circuits for speed.
    // PSM 7 ("single line") applies Tesseract's line-finding heuristics,
    // which on a small isolated digit crop repeatably misread distinct
    // digits (e.g. 5 as 3). PSM 13 ("raw line") skips those heuristics and
    // reads the crop as-is, which measured reliably correct on the same crops.
    const offsets = [
      [0, 0], [xShift, 0], [xShift, yShift],
      [0, yShift], [-xShift, yShift]
    ];
    const votes = new Map();
    for (const [offsetX, offsetY] of offsets) {
      const canvas = receiptRowCanvas(source, left + offsetX, top + offsetY, width, height);
      const recognition = await worker.recognize(canvas, {
        tessedit_pageseg_mode: 13,
        tessedit_char_whitelist: '0123456789'
      });
      const value = String(recognition.data.text || '').replace(/\D/g, '');
      const confidence = Number(recognition.data.confidence || 0);
      if (!value) continue;
      if (offsetX === 0 && offsetY === 0 && confidence >= 85) return value;
      const entry = votes.get(value) || { count: 0, bestConfidence: 0 };
      entry.count += 1;
      entry.bestConfidence = Math.max(entry.bestConfidence, confidence);
      votes.set(value, entry);
    }
    let winner = null;
    for (const [value, entry] of votes) {
      if (!winner || entry.count > winner.count ||
          (entry.count === winner.count && entry.bestConfidence > winner.bestConfidence)) {
        winner = { value, count: entry.count, bestConfidence: entry.bestConfidence };
      }
    }
    return winner ? winner.value : null;
  }

  function isReceiptValueConsistent(value, previousValues) {
    // No fixed receipt-number length is assumed.  A clearly shorter isolated
    // digit is only rejected after this same column already established its
    // own normal length, which protects against footer/stamp noise.
    if (previousValues.length < 2) return true;
    const lengths = previousValues.map((item) => item.length).sort((first, second) => first - second);
    const referenceLength = lengths[Math.floor(lengths.length / 2)];
    return value.length >= Math.max(1, referenceLength - 1);
  }

  function receiptRowCanvas(source, left, top, width, height) {
    const safeLeft = Math.max(0, Math.min(source.width - 1, left));
    const safeTop = Math.max(0, Math.min(source.height - 1, top));
    const safeWidth = Math.max(1, Math.min(width, source.width - safeLeft));
    const safeHeight = Math.max(1, Math.min(height, source.height - safeTop));
    const canvas = document.createElement('canvas');
    canvas.width = safeWidth * RECEIPT_ROW_UPSCALE;
    canvas.height = safeHeight * RECEIPT_ROW_UPSCALE;
    const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
    context.drawImage(source, safeLeft, safeTop, safeWidth, safeHeight, 0, 0, canvas.width, canvas.height);
    applyOcrContrast(context, canvas.width, canvas.height, 1.3, 150);
    return canvas;
  }

  function findInvoiceNumber(data) {
    const sourceText = typeof data === 'string' ? data : data?.text;
    const lines = linesFromTsv(data?.tsv);

    // A photographed table can scramble full-page OCR order.  Prefer the
    // block holding the invoice sentence so table serials never become a code.
    for (const block of blocksFromLines(lines)) {
      const code = findInvoiceTextWithAnchor(block.text, true);
      if (code) return code;
    }

    // OCR occasionally separates the number and the "nomreli" text into
    // nearby lines.  This fallback only accepts a numeric line to the left of
    // that anchor, which deliberately excludes the lower table region.
    for (const line of lines) {
      const code = findInvoiceNumberFromNomreliBlock(line.text);
      if (code) return code;
    }
    const nearby = findInvoiceNumberByLineGeometry(lines);
    if (nearby) return nearby;

    // TSV is normally present.  Only use raw page text when it is absent:
    // otherwise a table cell may be adjacent to the sentence in OCR order.
    if (lines.length) return null;
    const text = sourceText;
    const robust = findInvoiceTextWithAnchor(text, true);
    if (robust) return robust;
    const normalized = normalizeForAnchor(text);
    const anchor = /n\s*[ou]?\s*m\s*[ae]?\s*r\s*[ae]?\s*l+\s*i\s*[,.:;\-]?\s*(?:f\s*a\s*k\s*t\s*u\s*r\s*a)?\s*(?:y\s*a)?\s*[ae]\s*s\s*a\s*s\s*[ae]\s*n/i;
    const simpleAnchor = /n\s*[ou]?\s*m\s*[ae]?\s*r\s*[ae]?\s*l+\s*i/i;
    let match = anchor.exec(normalized);
    if (!match) {
      const candidate = simpleAnchor.exec(normalized);
      if (!candidate) return null;
      const right = normalized.slice(candidate.index, candidate.index + 100);
      if (!right.includes('faktur') && !right.includes('esasen')) return null;
      match = candidate;
    }
    const left = normalized.slice(0, match.index);
    const numberAtEnd = left.match(/(?:\d[\d\s./\\,:;_|\-–—]*)$/);
    if (!numberAtEnd) return null;
    const result = numberAtEnd[0].replace(/\D/g, '');
    return result || null;
  }

  function findInvoiceTextWithAnchor(text, requireSentenceContext) {
    const normalized = normalizeForAnchor(text);
    for (const anchorStart of nomreliPositions(normalized)) {
      const right = normalized.slice(anchorStart, anchorStart + 120);
      if (requireSentenceContext && !right.includes('faktur') && !hasEsasenLike(right)) continue;
      const code = extractDigitsImmediatelyBefore(normalized, anchorStart);
      if (code) return code;
    }
    // A weak camera OCR can distort "nomreli" much more than the surrounding
    // phrase (for example, hsmrali).  Inside one OCR block, the complete
    // "faktura ... esasen" context is still a safe anchor: take only the last
    // numeric run immediately before that phrase, never a value from a table.
    if (requireSentenceContext) return findInvoiceNumberBeforeFacturaContext(normalized);
    return null;
  }

  function findInvoiceNumberBeforeFacturaContext(normalized) {
    const phrase = /f\s*a\s*k\s*t\s*[uv]\s*r\s*a?/gi;
    for (const match of normalized.matchAll(phrase)) {
      const right = normalized.slice(match.index, match.index + 120);
      if (!hasEsasenLike(right)) continue;
      const before = normalized.slice(Math.max(0, match.index - 120), match.index);
      const runs = [...before.matchAll(/\d[\d\s./\\,:;_|\-–—]*/g)];
      const last = runs.at(-1)?.[0];
      if (!last) continue;
      const code = last.replace(/\D/g, '');
      if (code) return code;
    }
    return null;
  }

  function hasEsasenLike(value) {
    const compact = normalizeForAnchor(value).replace(/[^a-z]/g, '');
    if (compact.includes('esasen')) return true;
    for (let start = 0; start < compact.length; start += 1) {
      for (let end = start + 5; end <= Math.min(compact.length, start + 7); end += 1) {
        if (editDistanceAtMost(compact.slice(start, end), 'esasen', 2)) return true;
      }
    }
    return false;
  }

  function findInvoiceNumberFromNomreliBlock(text) {
    return findInvoiceTextWithAnchor(text, true);
  }

  function findInvoiceNumberByLineGeometry(lines) {
    for (const line of lines) {
      for (const anchor of invoiceAnchorBoxes(line)) {
        let closest = null;
        let closestScore = Number.POSITIVE_INFINITY;
        for (const candidate of lines) {
          if (candidate === line || !containsDigit(candidate.text)) continue;
          const verticalDistance = Math.abs(centerY(anchor) - centerY(candidate));
          const allowedVerticalDistance = Math.max(anchor.height, candidate.height) * 2.5;
          if (verticalDistance > allowedVerticalDistance) continue;

          // A true invoice number is on the same visual band and to the left
          // of "nomreli".  Numbers below it live in the table and are ignored.
          const candidateRight = candidate.left + candidate.width;
          const leftAllowance = Math.max(12, anchor.height * .9);
          if (candidateRight > anchor.left + leftAllowance) continue;
          const score = verticalDistance * 20 + Math.max(0, anchor.left - candidateRight);
          if (score < closestScore) {
            closest = candidate;
            closestScore = score;
          }
        }
        const code = closest && extractTrailingDigits(closest.text);
        if (code) return code;
      }
    }
    return null;
  }

  function invoiceAnchorBoxes(line) {
    const boxes = [];
    const tokens = line.tokens || [];
    for (let start = 0; start < tokens.length; start += 1) {
      let text = '';
      let box = null;
      for (let end = start; end < Math.min(tokens.length, start + 3); end += 1) {
        text += tokens[end].text;
        box = box ? unionBox(box, tokens[end]) : tokens[end];
        if (isNomreliLike(text)) {
          boxes.push(box);
          break;
        }
      }
    }
    return boxes.length ? boxes : (isNomreliLike(line.text) ? [line] : []);
  }

  function nomreliPositions(normalized) {
    const positions = new Set();
    const spaced = /n\s*[o0u]?\s*(?:m|rn)\s*[ae3]?\s*r\s*[ae3]?\s*l+\s*[i1]/gi;
    for (const match of normalized.matchAll(spaced)) positions.add(match.index);
    for (const match of normalized.matchAll(/[a-z0-9]+/gi)) {
      if (isNomreliLike(match[0])) positions.add(match.index);
    }
    return [...positions].sort((first, second) => first - second);
  }

  function isNomreliLike(value) {
    const compact = normalizeForAnchor(value)
      .replace(/[01]/g, (character) => character === '0' ? 'o' : 'i')
      .replace(/[^a-z]/g, '');
    if (!compact) return false;
    if (compact.includes('nomreli')) return true;
    for (let start = 0; start < compact.length; start += 1) {
      for (let end = start + 5; end <= Math.min(compact.length, start + 8); end += 1) {
        if (editDistanceAtMost(compact.slice(start, end), 'nomreli', 2)) return true;
      }
    }
    return false;
  }

  function containsDigit(text) { return /\d/.test(String(text || '')); }

  function extractTrailingDigits(text) {
    const normalized = normalizeForAnchor(text);
    let end = normalized.length;
    while (end > 0 && !/\d/.test(normalized[end - 1])) end -= 1;
    return end ? extractDigitsImmediatelyBefore(normalized, end) : null;
  }

  function extractDigitsImmediatelyBefore(normalized, anchorStart) {
    const left = normalized.slice(0, anchorStart);
    let cursor = left.length - 1;
    while (cursor >= 0 && !/\d/.test(left[cursor])) cursor -= 1;
    if (cursor < 0) return null;

    const end = cursor + 1;
    let seenDigit = false;
    while (cursor >= 0) {
      const value = left[cursor];
      if (/\d/.test(value)) {
        seenDigit = true;
        cursor -= 1;
      } else if (seenDigit && isInvoiceSeparator(value)) {
        cursor -= 1;
      } else {
        break;
      }
    }
    const result = left.slice(cursor + 1, end).replace(/\D/g, '');
    return result || null;
  }

  function isInvoiceSeparator(value) { return /[\s\-–—/\\.,:;_|()[\]{}'\"]/.test(value); }

  function normalizeForAnchor(value) {
    return String(value || '').toLocaleLowerCase('az')
      .replaceAll('ə', 'e').replaceAll('ä', 'e').replaceAll('ö', 'o').replaceAll('ü', 'u')
      .replaceAll('ı', 'i').replaceAll('ş', 's').replaceAll('ç', 'c').replaceAll('ğ', 'g');
  }

  function findReceiptNumbers(data) {
    const { headers, numbers } = receiptHeaderCandidates(data);
    let best = [];
    for (const header of headers) {
      const values = receiptRowsForHeader(header, numbers).map((row) => row.value);
      if (values.length > best.length) best = values;
    }
    return best;
  }

  function receiptHeaderCandidates(data) {
    const words = wordsFromTsv(data?.tsv);
    const lines = linesFromTsv(data?.tsv);
    const headers = receiptHeadersFrom(words, lines);
    let numbers = words.map((word) => ({ ...word, value: numericCellValue(word.text) })).filter((word) => word.value);
    // Tesseract usually returns cell-sized word boxes.  Keep a line fallback
    // for scans where it exposed a whole receipt cell as one line instead.
    if (!numbers.length) numbers = lines.map((line) => ({ ...line, value: numericCellValue(line.text) })).filter((line) => line.value);
    return { headers, numbers };
  }

  // Rows this header's column actually contains, at their own measured TSV
  // position — not a row-pitch estimate. Returns row boxes (not just values)
  // so callers can re-OCR each cell at its real location.
  function receiptRowsForHeader(header, numbers) {
    const candidates = numbers.filter((word) => isBelowHeader(word, header) && isInHeaderColumn(word, header));
    const groupedRows = makeRows(candidates);
    if (!groupedRows.length) return [];
    const startGap = groupedRows[0].centerY - centerY(header);
    if (startGap > Math.max(header.height * 6.5, groupedRows[0].height * 4)) return [];
    const rows = [];
    let previous = null;
    let typicalPitch = 0;
    for (const row of groupedRows) {
      if (previous) {
        const gap = row.centerY - previous.centerY;
        const gapLimit = Math.max(Math.max(header.height, previous.height, row.height) * 4.5, typicalPitch ? typicalPitch * 2.5 : 0);
        if (gap > gapLimit) break;
        typicalPitch = typicalPitch ? typicalPitch * .65 + gap * .35 : gap;
      }
      rows.push(row);
      previous = row;
    }
    return rows;
  }

  function receiptHeadersFrom(words, lines) {
    const wordHeaders = words.filter((word) => isReceiptHeader(word.text));
    if (wordHeaders.length) return wordHeaders;

    // A short header such as Qebz can be split into two OCR words.  Rebuild a
    // tight box from adjacent words instead of using a whole table row, whose
    // width would otherwise reach the serial/model columns.
    const headers = [];
    for (const line of lines) {
      const tokens = line.tokens || [];
      for (let start = 0; start < tokens.length; start += 1) {
        let text = '';
        let box = null;
        for (let end = start; end < Math.min(tokens.length, start + 3); end += 1) {
          text += tokens[end].text;
          box = box ? unionBox(box, tokens[end]) : tokens[end];
          if (isReceiptHeader(text)) {
            headers.push({ ...box, text });
            break;
          }
        }
      }
    }
    return headers;
  }

  function wordsFromTsv(tsv) {
    return String(tsv || '').split(/\r?\n/).slice(1).map((line) => {
      const fields = line.split('\t');
      if (fields.length < 12 || Number(fields[0]) !== 5) return null;
      const [, page, block, paragraph, lineNumber, wordNumber, left, top, width, height, confidence, ...textParts] = fields;
      return {
        text: textParts.join('\t') || '', left: +left, top: +top, width: +width, height: +height,
        page: +page, block: +block, paragraph: +paragraph, lineNumber: +lineNumber, wordNumber: +wordNumber, confidence: +confidence
      };
    }).filter(Boolean);
  }

  function linesFromTsv(tsv) {
    const grouped = new Map();
    for (const word of wordsFromTsv(tsv)) {
      const key = `${word.page}:${word.block}:${word.paragraph}:${word.lineNumber}`;
      if (!grouped.has(key)) grouped.set(key, { page: word.page, block: word.block, paragraph: word.paragraph, lineNumber: word.lineNumber, tokens: [] });
      grouped.get(key).tokens.push(word);
    }
    return [...grouped.values()].map((group) => {
      const tokens = [...group.tokens].sort((first, second) => first.left - second.left || first.top - second.top);
      const box = boxAround(tokens);
      return { ...group, ...box, tokens, text: tokens.map((token) => token.text).join(' ').trim() };
    }).filter((line) => line.text && line.width > 0 && line.height > 0)
      .sort((first, second) => first.top - second.top || first.left - second.left);
  }

  function blocksFromLines(lines) {
    const grouped = new Map();
    for (const line of lines) {
      const key = `${line.page}:${line.block}`;
      if (!grouped.has(key)) grouped.set(key, { page: line.page, block: line.block, lines: [] });
      grouped.get(key).lines.push(line);
    }
    return [...grouped.values()].map((group) => {
      const blockLines = [...group.lines].sort((first, second) => first.top - second.top || first.left - second.left);
      return { ...group, ...boxAround(blockLines), text: blockLines.map((line) => line.text).join(' ') };
    });
  }

  function boxAround(items) {
    const left = Math.min(...items.map((item) => item.left));
    const top = Math.min(...items.map((item) => item.top));
    const right = Math.max(...items.map((item) => item.left + item.width));
    const bottom = Math.max(...items.map((item) => item.top + item.height));
    return { left, top, width: right - left, height: bottom - top };
  }

  function unionBox(first, second) {
    return boxAround([first, second]);
  }

  function isReceiptHeader(text) {
    const value = normalizeForAnchor(text).replace(/[^a-z0-9]/g, '').replaceAll('2', 'z');
    if (value.includes('qbz') || value.includes('qeb') || value.includes('qab')) return true;
    for (let length = 4; length <= 5; length += 1) {
      for (let start = 0; start + length <= value.length; start += 1) {
        if (editDistanceAtMostOne(value.slice(start, start + length), 'qebz') || editDistanceAtMostOne(value.slice(start, start + length), 'qabz')) return true;
      }
    }
    return false;
  }

  function editDistanceAtMost(value, target, limit) {
    if (Math.abs(value.length - target.length) > limit) return false;
    const previous = Array.from({ length: target.length + 1 }, (_, index) => index);
    for (let row = 1; row <= value.length; row += 1) {
      const current = [row];
      let minimum = row;
      for (let column = 1; column <= target.length; column += 1) {
        current[column] = Math.min(previous[column - 1] + (value[row - 1] === target[column - 1] ? 0 : 1), current[column - 1] + 1, previous[column] + 1);
        minimum = Math.min(minimum, current[column]);
      }
      if (minimum > limit) return false;
      previous.splice(0, previous.length, ...current);
    }
    return previous[target.length] <= limit;
  }

  function editDistanceAtMostOne(value, target) { return editDistanceAtMost(value, target, 1); }

  function numericCellValue(text) {
    const replacements = { o: '0', O: '0', i: '1', I: '1', l: '1', L: '1', z: '2', Z: '2', s: '5', S: '5', b: '8', B: '8', g: '6', G: '6' };
    let output = '';
    for (const character of String(text || '')) {
      if (/\d/.test(character)) output += character;
      else if (replacements[character]) output += replacements[character];
      else if (/\s|[-–—/\\.,:;_|()[\]{}'"]/.test(character)) continue;
      else return null;
    }
    return output || null;
  }

  function isBelowHeader(candidate, header) { return centerY(candidate) > header.top + header.height + Math.max(1, header.height * .15); }
  function isInHeaderColumn(candidate, header) {
    const tolerance = Math.max(header.width * 1.2, candidate.width * .8) + Math.max(header.height, candidate.height) * .7;
    return Math.abs(centerX(candidate) - centerX(header)) <= tolerance;
  }
  function centerX(box) { return box.left + box.width / 2; }
  function centerY(box) { return box.top + box.height / 2; }

  function makeRows(tokens) {
    const sorted = [...tokens].sort((a, b) => centerY(a) - centerY(b) || a.left - b.left);
    const rows = [];
    for (const token of sorted) {
      const row = rows.at(-1);
      if (!row || Math.abs(centerY(token) - row.centerY) > Math.max(3, Math.max(token.height, row.height) * .6)) {
        rows.push({ tokens: [token], centerY: centerY(token), height: token.height, value: token.value, left: token.left, top: token.top, width: token.width });
      } else {
        row.tokens.push(token);
        row.centerY = row.tokens.reduce((sum, item) => sum + centerY(item), 0) / row.tokens.length;
        row.height = row.tokens.reduce((sum, item) => sum + item.height, 0) / row.tokens.length;
        row.value = [...row.tokens].sort((a, b) => a.left - b.left).map((item) => item.value).join('');
        const box = boxAround(row.tokens);
        row.left = box.left; row.top = box.top; row.width = box.width;
      }
    }
    return rows;
  }

  function rotateActivePage(degrees) {
    const session = currentSession();
    const page = session.pages[session.activeIndex];
    if (!page || state.processing) return;
    page.scanCanvas = rotateCanvas(page.scanCanvas, degrees);
    session.lastDetail = 'Scan döndərildi. Rəngli görünüş qorunur.';
    render();
  }

  async function saveAllAsJpg() {
    const session = currentSession();
    if (!session.pages.length || state.processing) return;
    const files = await pageFiles(session.pages, 'TTAKT_SCAN');
    try {
      if (navigator.share && navigator.canShare?.({ files })) {
        await navigator.share({ files, title: 'TTAKTScanner JPG' });
        session.lastDetail = 'JPG paylaşım pəncərəsinə verildi. iPhone-da “Save Image” seçin.';
      } else {
        files.forEach((file, index) => setTimeout(() => downloadFile(file), index * 260));
        session.lastDetail = 'JPG faylları yükləməyə göndərildi.';
      }
    } catch (error) {
      if (error?.name !== 'AbortError') session.lastDetail = 'JPG saxlanması ləğv edildi və ya brauzer dəstəkləmədi.';
    }
    render();
  }

  async function saveAllAsPdf() {
    const session = currentSession();
    if (!session.pages.length || state.processing) return;
    if (!window.jspdf?.jsPDF) {
      session.lastDetail = 'PDF modulu yüklənmədi.';
      render();
      return;
    }
    setWorking(true, 'PDF hazırlanır…', state.mode);
    try {
      const { jsPDF } = window.jspdf;
      let documentPdf = null;
      session.pages.forEach((page, index) => {
        const portrait = page.scanCanvas.height >= page.scanCanvas.width;
        if (!documentPdf) documentPdf = new jsPDF({ orientation: portrait ? 'p' : 'l', unit: 'px', format: [page.scanCanvas.width, page.scanCanvas.height], compress: true });
        else documentPdf.addPage([page.scanCanvas.width, page.scanCanvas.height], portrait ? 'p' : 'l');
        documentPdf.addImage(page.scanCanvas.toDataURL('image/jpeg', .95), 'JPEG', 0, 0, page.scanCanvas.width, page.scanCanvas.height, `scan-${index}`, 'FAST');
      });
      const blob = documentPdf.output('blob');
      downloadFile(new File([blob], `TTAKT_SCAN_${timestamp()}.pdf`, { type: 'application/pdf' }));
      session.lastDetail = 'Bütün scan səhifələri bir PDF kimi hazırlandı.';
    } catch (_) {
      session.lastDetail = 'PDF yaradıla bilmədi.';
    } finally {
      setWorking(false, '', state.mode);
      render();
    }
  }

  function whatsappCaption(mode, numbers) {
    if (mode === 'container') {
      return numbers.map((number) => `Qəbz nömrələri № ${number}`).join('\n');
    }
    return `Faktura № ${numbers[0]}`;
  }

  function shareOnWhatsapp() {
    const session = currentSession();
    if (!session.pages.length || state.processing) return;
    const numbers = state.mode === 'container'
      ? session.code.split(/[\r\n,;]+/).map((value) => value.replace(/\D/g, '')).filter(Boolean)
      : [session.code.replace(/\D/g, '')].filter(Boolean);
    if (!numbers.length) {
      session.lastDetail = state.mode === 'container' ? 'Ən azı bir qəbz nömrəsi yazın.' : 'Faktura kodunu yazın.';
      render();
      el.codeField.focus();
      return;
    }
    const caption = whatsappCaption(state.mode, numbers);
    try {
      // A browser may open WhatsApp with text, but it cannot attach a local photo
      // directly to WhatsApp without the system share sheet. Keep the photo as a
      // normal saved JPG and take the user straight to WhatsApp for the caption.
      window.location.href = `https://wa.me/?text=${encodeURIComponent(caption)}`;
      session.lastDetail = 'WhatsApp açıldı. Alıcını seçin.';
    } catch (error) {
      if (error?.name !== 'AbortError') session.lastDetail = 'WhatsApp paylaşımı baş tutmadı.';
    }
    render();
  }

  async function pageFiles(pages, prefix) {
    return Promise.all(pages.map(async (page, index) => {
      const blob = await canvasToBlob(page.scanCanvas, 'image/jpeg', .95);
      return new File([blob], `${prefix}_${timestamp()}_${index + 1}.jpg`, { type: 'image/jpeg' });
    }));
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('JPG hazırlana bilmədi.')), type, quality));
  }

  function downloadFile(file) {
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = file.name;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function resetCurrentScan() {
    const session = currentSession();
    session.generation += 1;
    session.pages = [];
    session.activeIndex = -1;
    session.code = '';
    session.lastDetail = 'Hazırkı scan sıfırlandı. Yeni sənəd çəkə bilərsiniz.';
    el.scanStatus.textContent = state.mode === 'container' ? 'Yeni konteyner aktının şəklini çəkin.' : 'Yeni aktın şəklini çəkin.';
    render();
  }

  function timestamp() {
    const date = new Date();
    const part = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}${part(date.getMonth() + 1)}${part(date.getDate())}_${part(date.getHours())}${part(date.getMinutes())}${part(date.getSeconds())}`;
  }

  window.addEventListener('beforeunload', () => { state.worker?.terminate?.(); });
  window.addEventListener('load', initialize);
})();
