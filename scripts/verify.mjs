import { access, readFile } from 'node:fs/promises';

const required = [
  'index.html', 'styles.css', 'app.js', 'service-worker.js', 'manifest.webmanifest', 'vercel.json',
  'assets/ttakt-scanner-logo.png', 'vendor/opencv.js', 'vendor/tesseract.min.js', 'vendor/worker.min.js',
  'vendor/tesseract-core.wasm.js', 'vendor/tesseract-core.wasm', 'vendor/tessdata/eng.traineddata.gz', 'vendor/jspdf.umd.min.js'
];

for (const file of required) await access(new URL(`../${file}`, import.meta.url));
const app = await readFile(new URL('../app.js', import.meta.url), 'utf8');
for (const feature of ['makeColorScan', 'findInvoiceNumber', 'findReceiptNumbers', 'saveAllAsPdf', 'shareOnWhatsapp', 'resetCurrentScan']) {
  if (!app.includes(feature)) throw new Error(`Missing required feature: ${feature}`);
}
console.log('TTAKTScanner Web: static deployment package verified.');
