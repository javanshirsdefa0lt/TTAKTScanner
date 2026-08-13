/* TTAKTScanner Web — all scan and OCR work is performed in this browser. */
(() => {
  'use strict';

  const MAX_SOURCE_EDGE = 2300;
  const MAX_DETECTION_EDGE = 1280;
  const OCV_READY_TIMEOUT = 20000;

  const el = {
    cameraInput: document.querySelector('#cameraInput'),
    fileInput: document.querySelector('#fileInput'),
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
    resetScan: document.querySelector('#resetScan')
  };

  const state = {
    mode: 'delivery',
    sessions: { delivery: createSession(), container: createSession() },
    worker: null,
    workerPromise: null,
    ocrQueue: Promise.resolve(),
    cvPromise: null,
    processing: 0
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
          shareTitle: 'Qəbz nömrələri:'
        }
      : {
          eyebrow: 'TƏHVİL-TƏSLİM AKTI',
          title: 'Faktura kodunu tap',
          description: '“nömrəli fakturaya əsasən” ifadəsindən əvvəlki rəqəmlər birləşdiriləcək.',
          label: 'FAKTURA KODU',
          help: 'OCR nəticəsini göndərməzdən əvvəl yoxlayın.',
          shareTitle: 'Faktura №:'
        };
  }

  function initialize() {
    el.modeButtons.forEach((button) => button.addEventListener('click', () => switchMode(button.dataset.mode)));
    el.cameraInput.addEventListener('change', onFileChosen);
    el.fileInput.addEventListener('change', onFileChosen);
    el.codeField.addEventListener('input', () => { currentSession().code = el.codeField.value; });
    el.rotateLeft.addEventListener('click', () => rotateActivePage(-90));
    el.rotateRight.addEventListener('click', () => rotateActivePage(90));
    el.addPage.addEventListener('click', () => el.cameraInput.click());
    el.saveJpg.addEventListener('click', saveAllAsJpg);
    el.savePdf.addEventListener('click', saveAllAsPdf);
    el.shareWhatsapp.addEventListener('click', shareOnWhatsapp);
    el.resetScan.addEventListener('click', resetCurrentScan);
    render();
    registerServiceWorker();
  }

  function registerServiceWorker() {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('./service-worker.js').catch(() => undefined);
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
    const session = state.sessions[modeAtStart];
    const generation = session.generation;
    setWorking(true, 'Rəngli scan hazırlanır…', modeAtStart);
    try {
      const sourceCanvas = await imageFileToCanvas(file);
      const scan = await makeColorScan(sourceCanvas);
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

  async function makeColorScan(sourceCanvas) {
    try {
      const cv = await getOpenCv();
      return scanWithOpenCv(cv, sourceCanvas);
    } catch (_) {
      return { canvas: cloneCanvas(sourceCanvas), detected: false };
    }
  }

  function getOpenCv() {
    if (state.cvPromise) return state.cvPromise;
    state.cvPromise = new Promise((resolve, reject) => {
      const ready = (module) => module && module.Mat && typeof module.imread === 'function';
      const cv = window.cv;
      if (ready(cv)) { resolve(cv); return; }
      if (typeof cv === 'function') {
        Promise.resolve(cv()).then((module) => {
          if (ready(module)) { window.cv = module; resolve(module); } else reject(new Error('OpenCV hazır deyil.'));
        }).catch(reject);
        return;
      }
      if (!cv) { reject(new Error('OpenCV yüklənmədi.')); return; }
      const timer = window.setTimeout(() => reject(new Error('OpenCV gecikdi.')), OCV_READY_TIMEOUT);
      const previous = cv.onRuntimeInitialized;
      cv.onRuntimeInitialized = () => {
        window.clearTimeout(timer);
        if (typeof previous === 'function') previous();
        ready(window.cv) ? resolve(window.cv) : reject(new Error('OpenCV hazır deyil.'));
      };
    });
    return state.cvPromise;
  }

  function scanWithOpenCv(cv, sourceCanvas) {
    const source = cv.imread(sourceCanvas);
    const detection = new cv.Mat();
    let warped = null;
    try {
      const largest = Math.max(source.cols, source.rows);
      const factor = Math.min(1, MAX_DETECTION_EDGE / largest);
      cv.resize(source, detection, new cv.Size(Math.round(source.cols * factor), Math.round(source.rows * factor)), 0, 0, cv.INTER_AREA);
      const corners = detectDocumentCorners(cv, detection);
      if (corners) {
        const fullCorners = corners.map((point) => ({ x: point.x / factor, y: point.y / factor }));
        warped = warpDocument(cv, source, fullCorners);
      } else {
        warped = source.clone();
      }
      const canvas = document.createElement('canvas');
      cv.imshow(canvas, warped);
      return { canvas, detected: Boolean(corners) };
    } finally {
      source.delete();
      detection.delete();
      warped?.delete();
    }
  }

  function detectDocumentCorners(cv, rgba) {
    const gray = new cv.Mat();
    const blur = new cv.Mat();
    const edges = new cv.Mat();
    const hierarchy = new cv.Mat();
    const contours = new cv.MatVector();
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    let best = null;
    let bestArea = 0;
    try {
      cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
      cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
      cv.Canny(blur, edges, 60, 160);
      cv.dilate(edges, edges, kernel);
      cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
      const imageArea = rgba.cols * rgba.rows;
      for (let index = 0; index < contours.size(); index += 1) {
        const contour = contours.get(index);
        const approx = new cv.Mat();
        try {
          cv.approxPolyDP(contour, approx, cv.arcLength(contour, true) * .02, true);
          if (approx.rows !== 4 || !cv.isContourConvex(approx)) continue;
          const area = Math.abs(cv.contourArea(approx));
          const bounds = cv.boundingRect(approx);
          const coversMostOfImage = bounds.width / rgba.cols >= .70 && bounds.height / rgba.rows >= .70;
          if (area <= imageArea * .40 || !coversMostOfImage || area <= bestArea) continue;
          const points = pointsFromMat(approx);
          if (points.length !== 4) continue;
          best = orderCorners(points);
          bestArea = area;
        } finally {
          contour.delete();
          approx.delete();
        }
      }
      return best;
    } finally {
      gray.delete(); blur.delete(); edges.delete(); hierarchy.delete(); contours.delete(); kernel.delete();
    }
  }

  function pointsFromMat(mat) {
    const data = mat.data32S?.length ? mat.data32S : mat.data32F;
    const points = [];
    for (let index = 0; index + 1 < data.length; index += 2) points.push({ x: data[index], y: data[index + 1] });
    return points;
  }

  function orderCorners(points) {
    const bySum = [...points].sort((a, b) => (a.x + a.y) - (b.x + b.y));
    const byDiff = [...points].sort((a, b) => (a.y - a.x) - (b.y - b.x));
    return [bySum[0], byDiff[0], bySum[3], byDiff[3]];
  }

  function warpDocument(cv, source, points) {
    const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const width = Math.max(600, Math.round(Math.max(distance(points[0], points[1]), distance(points[3], points[2]))));
    const height = Math.max(600, Math.round(Math.max(distance(points[0], points[3]), distance(points[1], points[2]))));
    const sourcePoints = cv.matFromArray(4, 1, cv.CV_32FC2, points.flatMap((point) => [point.x, point.y]));
    const destinationPoints = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, width - 1, 0, width - 1, height - 1, 0, height - 1]);
    const transform = cv.getPerspectiveTransform(sourcePoints, destinationPoints);
    const output = new cv.Mat();
    try {
      cv.warpPerspective(source, output, transform, new cv.Size(width, height), cv.INTER_CUBIC, cv.BORDER_REPLICATE);
      return output;
    } finally {
      sourcePoints.delete(); destinationPoints.delete(); transform.delete();
    }
  }

  function cloneCanvas(source) {
    const clone = document.createElement('canvas');
    clone.width = source.width;
    clone.height = source.height;
    clone.getContext('2d', { alpha: false }).drawImage(source, 0, 0);
    return clone;
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
      for (const degrees of [0, 90, 180, 270]) {
        if (generation !== session.generation) return;
        const source = degrees === 0 ? page.sourceCanvas : rotateCanvas(page.sourceCanvas, degrees);
        const recognition = await worker.recognize(source);
        const found = mode === 'container'
          ? findReceiptNumbers(recognition.data)
          : findInvoiceNumber(recognition.data.text);
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
    } catch (_) {
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
      state.workerPromise = window.Tesseract.createWorker('eng', 1, {
        workerPath: './vendor/worker.min.js',
        corePath: './vendor/tesseract-core.wasm.js',
        langPath: './vendor/tessdata',
        cacheMethod: 'write'
      }).then((worker) => { state.worker = worker; return worker; });
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

  function findInvoiceNumber(text) {
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

  function normalizeForAnchor(value) {
    return String(value || '').toLocaleLowerCase('az')
      .replaceAll('ə', 'e').replaceAll('ä', 'e').replaceAll('ö', 'o').replaceAll('ü', 'u')
      .replaceAll('ı', 'i').replaceAll('ş', 's').replaceAll('ç', 'c').replaceAll('ğ', 'g');
  }

  function findReceiptNumbers(data) {
    const words = wordsFromTsv(data.tsv);
    const headers = words.filter((word) => isReceiptHeader(word.text));
    if (!headers.length) return [];
    const numbers = words.map((word) => ({ ...word, value: numericCellValue(word.text) })).filter((word) => word.value);
    let best = [];
    for (const header of headers) {
      const candidates = numbers.filter((word) => isBelowHeader(word, header) && isInHeaderColumn(word, header));
      const groupedRows = makeRows(candidates);
      if (!groupedRows.length) continue;
      const startGap = groupedRows[0].centerY - centerY(header);
      if (startGap > Math.max(header.height * 6.5, groupedRows[0].height * 4)) continue;
      const values = [];
      let previous = null;
      let typicalPitch = 0;
      for (const row of groupedRows) {
        if (previous) {
          const gap = row.centerY - previous.centerY;
          const gapLimit = Math.max(Math.max(header.height, previous.height, row.height) * 4.5, typicalPitch ? typicalPitch * 2.5 : 0);
          if (gap > gapLimit) break;
          typicalPitch = typicalPitch ? typicalPitch * .65 + gap * .35 : gap;
        }
        values.push(row.value);
        previous = row;
      }
      if (values.length > best.length) best = values;
    }
    return best;
  }

  function wordsFromTsv(tsv) {
    return String(tsv || '').split(/\r?\n/).slice(1).map((line) => {
      const fields = line.split('\t');
      if (fields.length < 12 || Number(fields[0]) !== 5) return null;
      const [, , , , , , left, top, width, height, , ...textParts] = fields;
      return { text: textParts.join('\t') || '', left: +left, top: +top, width: +width, height: +height };
    }).filter(Boolean);
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

  function editDistanceAtMostOne(value, target) {
    if (Math.abs(value.length - target.length) > 1) return false;
    const previous = Array.from({ length: target.length + 1 }, (_, index) => index);
    for (let row = 1; row <= value.length; row += 1) {
      const current = [row];
      let minimum = row;
      for (let column = 1; column <= target.length; column += 1) {
        current[column] = Math.min(previous[column - 1] + (value[row - 1] === target[column - 1] ? 0 : 1), current[column - 1] + 1, previous[column] + 1);
        minimum = Math.min(minimum, current[column]);
      }
      if (minimum > 1) return false;
      previous.splice(0, previous.length, ...current);
    }
    return previous[target.length] <= 1;
  }

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
        rows.push({ tokens: [token], centerY: centerY(token), height: token.height, value: token.value });
      } else {
        row.tokens.push(token);
        row.centerY = row.tokens.reduce((sum, item) => sum + centerY(item), 0) / row.tokens.length;
        row.height = row.tokens.reduce((sum, item) => sum + item.height, 0) / row.tokens.length;
        row.value = [...row.tokens].sort((a, b) => a.left - b.left).map((item) => item.value).join('');
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

  async function shareOnWhatsapp() {
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
    const copy = copyFor(state.mode);
    const caption = `${copy.shareTitle}\n${numbers.join('\n')}`;
    const files = await pageFiles(session.pages, state.mode === 'container' ? 'TTAKT_CONTAINER' : 'TTAKT_AKT');
    try {
      if (navigator.share && navigator.canShare?.({ files })) {
        await navigator.share({ title: 'TTAKTScanner', text: caption, files });
        session.lastDetail = 'Paylaşım pəncərəsi açıldı. WhatsApp seçin.';
      } else {
        window.open(`https://wa.me/?text=${encodeURIComponent(caption)}`, '_blank', 'noopener');
        files.forEach((file, index) => setTimeout(() => downloadFile(file), index * 260));
        session.lastDetail = 'WhatsApp mətni açıldı; şəkillər ayrıca yükləməyə verildi.';
      }
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
