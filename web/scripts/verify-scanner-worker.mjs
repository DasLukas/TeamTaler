import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const assetDirectory = fileURLToPath(new URL('../dist/assets/', import.meta.url));
const workerPattern = /^documentDetection\.worker-[A-Za-z0-9_-]+\.js$/;
const maximumWorkerBytes = 256 * 1024;
const workerNames = (await readdir(assetDirectory)).filter((name) => workerPattern.test(name));

if (workerNames.length !== 1) {
  throw new Error(`Expected one built document-detection worker, found ${workerNames.length}.`);
}

const workerPath = join(assetDirectory, workerNames[0]);
const [source, metadata] = await Promise.all([readFile(workerPath, 'utf8'), stat(workerPath)]);
if (metadata.size > maximumWorkerBytes) {
  throw new Error(`Document-detection worker is unexpectedly large (${metadata.size} bytes).`);
}
if (/\beval\s*\(|\b(?:new\s+)?Function\s*\(/u.test(source)) {
  throw new Error('Document-detection worker contains dynamic JavaScript execution forbidden by the production CSP.');
}

console.log(`Verified CSP-safe document-detection worker (${metadata.size} bytes).`);
