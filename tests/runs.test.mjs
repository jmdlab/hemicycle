import test from 'node:test';
import assert from 'node:assert/strict';
import { groupRuns, mergeHead } from '../src/lib/runs.ts';

const s = (numero, dossierRef) => ({ numero, dossierRef });

test('consecutive votes on one text: newest is the head, the rest follow in order', () => {
  const runs = groupRuns([s(9, 'A'), s(8, 'A'), s(7, 'A'), s(6, 'B'), s(5, null), s(4, null), s(3, 'A')]);
  assert.deepEqual(
    runs.map((r) => [r.key, r.rest.map((x) => x.numero)]),
    [['A#0', [8, 7]], ['B#0', []], ['n5', []], ['n4', []], ['A#1', []]],
  );
});

test('a run cut by a page boundary merges and keeps its key when the next page is appended', () => {
  const page1 = [s(20, 'PLF'), s(19, 'PLF')];
  const page2 = [s(18, 'PLF'), s(17, 'X')];
  const before = groupRuns(page1);
  const after = groupRuns([...page1, ...page2]);
  assert.equal(before[0].key, after[0].key);
  assert.deepEqual(after[0].rest.map((x) => x.numero), [19, 18]);
  assert.equal(after.length, 2);
});

test('a new vote on the open text keeps its key; keys stay unique', () => {
  const before = groupRuns([s(20, 'PLF'), s(19, 'PLF'), s(18, 'X'), s(17, 'PLF')]);
  const after = groupRuns([s(21, 'PLF'), s(20, 'PLF'), s(19, 'PLF'), s(18, 'X'), s(17, 'PLF')]);
  assert.equal(after[0].key, before[0].key);
  const keys = after.map((r) => r.key);
  assert.equal(new Set(keys).size, keys.length);
});

test('a refreshed first page keeps the older rows already loaded', () => {
  const prev = [s(10), s(9), s(8), s(7), s(6), s(5)];
  const fresh = [s(11), s(10), s(9)];
  assert.deepEqual(mergeHead(fresh, prev).map((x) => x.numero), [11, 10, 9, 8, 7, 6, 5]);
  assert.deepEqual(mergeHead(fresh, null).map((x) => x.numero), [11, 10, 9]);
  // A ballot dropped upstream inside the fresh window disappears.
  assert.deepEqual(mergeHead([s(10), s(8)], prev).map((x) => x.numero), [10, 8, 7, 6, 5]);
});

test('empty list, and a head dropped by the nightly refresh', () => {
  assert.deepEqual(groupRuns([]), []);
  // 9 (head of A) disappears from the fresh page: the run lives on under the next A ballot.
  const merged = mergeHead([s(8, 'A'), s(7, 'A')], [s(9, 'A'), s(8, 'A'), s(7, 'A'), s(6, 'A')]);
  assert.deepEqual(merged.map((x) => x.numero), [8, 7, 6]);
  const [run] = groupRuns(merged);
  assert.equal(run.head.numero, 8);
  assert.deepEqual(run.rest.map((x) => x.numero), [7, 6]);
});

test('a new vote on A lands above another text: the old A run keeps its ballots', () => {
  const before = groupRuns([s(9, 'B'), s(8, 'A'), s(7, 'A')]);
  const after = groupRuns(mergeHead([s(10, 'A'), s(9, 'B')], [s(9, 'B'), s(8, 'A'), s(7, 'A')]));
  // The run the reader opened (ballots 8 and 7) is still one run, with the same ballots,
  // which is what the list's open state is keyed on (ballot numbers, not run position).
  const opened = before.find((r) => r.head.numero === 8);
  const same = after.find((r) => [r.head, ...r.rest].some((x) => x.numero === 8));
  assert.deepEqual([same.head, ...same.rest].map((x) => x.numero), [opened.head, ...opened.rest].map((x) => x.numero));
  assert.notEqual(same.key, opened.key); // its position key did shift — hence the numero-based state
});
