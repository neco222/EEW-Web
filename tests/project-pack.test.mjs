import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { compressProject } from '../scripts/pack-project.mjs';

test('gzip round-trips original UTF-8 bytes without reserializing JSON', () => {
  const input = Buffer.from('\ufeff{\r\n  "地名": "東京 🌏", "value": 1.000e2\r\n}\r\n', 'utf8');
  const unchanged = Buffer.from(input);
  const compressed = compressProject(input);
  assert.ok(Buffer.isBuffer(compressed));
  assert.equal(compressed.readUInt16LE(0), 0x8b1f);
  assert.deepEqual(gunzipSync(compressed), input);
  assert.deepEqual(input, unchanged);
  assert.deepEqual(compressProject(input), compressed);
});

test('accepts UTF-8 strings and rejects unsupported input types', () => {
  const input = '{ "text": "日本語", "lines": "\\n" }\n';
  assert.equal(gunzipSync(compressProject(input)).toString('utf8'), input);
  for (const invalid of [null, undefined, 42, {}, new Uint8Array([1, 2])]) {
    assert.throws(() => compressProject(invalid), TypeError);
  }
});

test('the complete original project decompresses byte-for-byte with a substantial size reduction', () => {
  const input = readFileSync(new URL('../docs/assets/project.json', import.meta.url));
  const compressed = compressProject(input);
  assert.deepEqual(gunzipSync(compressed), input);
  assert.ok(
    compressed.length < input.length * 0.6,
    `Expected under 60% of original size; got ${compressed.length}/${input.length} bytes`,
  );
});
