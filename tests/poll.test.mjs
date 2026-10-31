import test from 'node:test';
import assert from 'node:assert/strict';
import { isChanged } from '../scripts/poll.mjs';

test('same ETag → unchanged', () => {
  assert.equal(isChanged({ etag: '"a"', lastModified: 'x' }, { etag: '"a"', lastModified: 'y' }), false);
});
test('same Last-Modified, no ETag → unchanged', () => {
  assert.equal(isChanged({ etag: null, lastModified: 'x' }, { etag: '"a"', lastModified: 'x' }), false);
});
test('new ETag and new Last-Modified → changed', () => {
  assert.equal(isChanged({ etag: '"b"', lastModified: 'z' }, { etag: '"a"', lastModified: 'y' }), true);
});
test('HEAD failed → not treated as a change', () => {
  assert.equal(isChanged(null, { etag: '"a"' }), false);
});
test('never downloaded → changed', () => {
  assert.equal(isChanged({ etag: '"a"' }, undefined), true);
});
