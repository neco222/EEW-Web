import { gzipSync } from 'node:zlib';

// Compress the original UTF-8 bytes directly, preserving whitespace, ordering,
// numeric representations and all Scratch data without JSON reserialization.
export function compressProject(input) {
  if (typeof input !== 'string' && !Buffer.isBuffer(input)) {
    throw new TypeError('Project input must be a Buffer or UTF-8 string.');
  }
  return gzipSync(typeof input === 'string' ? Buffer.from(input, 'utf8') : input, {
    level: 9,
  });
}
