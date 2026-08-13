import { cp, mkdir } from 'node:fs/promises';

const files = ['index.html', 'styles.css', 'app.js', 'service-worker.js', 'manifest.webmanifest'];
const folders = ['assets', 'vendor'];
await mkdir('public', { recursive: true });
for (const file of files) await cp(file, `public/${file}`);
for (const folder of folders) await cp(folder, `public/${folder}`, { recursive: true, force: true });
console.log('Static Vercel output prepared in public/.');
