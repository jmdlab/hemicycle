import test from 'node:test';
import assert from 'node:assert/strict';
import { routeFromPath, pathForRoute, canonicalPath } from '../src/lib/route.ts';

test('paths → views', () => {
  const cases = [
    ['/9336', { k: 'scrutin', numero: 9336 }],
    ['/9336/', { k: 'scrutin', numero: 9336 }],
    ['/scrutin/9336', { k: 'scrutin', numero: 9336 }],
    ['/scrutins/9336/', { k: 'scrutin', numero: 9336 }],
    ['/0', { k: 'introuvable' }],
    ['/99999999999999999999', { k: 'introuvable' }],
    ['/scrutin', { k: 'introuvable' }],
    ['/Loi/x', { k: 'introuvable' }],
    ['/nimporte/quoi', { k: 'introuvable' }],
    ['/loi/plf-2027', { k: 'loi', slug: 'plf-2027' }],
    ['/depute/jean-dupont', { k: 'depute', slug: 'jean-dupont' }],
    ['/deputes/', { k: 'deputes' }],
    ['/', null],
    ['', null],
    ['/index.html', null],
  ];
  for (const [p, want] of cases) assert.deepEqual(routeFromPath(p), want, p);
});

test('canonical addresses', () => {
  assert.equal(pathForRoute({ k: 'scrutin', numero: 9336 }), '/9336');
  assert.equal(pathForRoute({ k: 'deputes' }), '/deputes');
  assert.equal(canonicalPath('/scrutin/9336'), '/9336');
  assert.equal(canonicalPath('/scrutins/9336/'), '/9336');
  assert.equal(canonicalPath('/deputes/'), '/deputes');
  assert.equal(canonicalPath('/index.html'), '/');
  assert.equal(canonicalPath('/9336'), null);
  assert.equal(canonicalPath('/'), null);
  // a not-found address stays as typed
  assert.equal(canonicalPath('/nimporte/quoi'), null);
  assert.equal(canonicalPath('/0'), null);
});
