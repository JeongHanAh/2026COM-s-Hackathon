import test from 'node:test';
import assert from 'node:assert/strict';
import { timelineGroups } from '../public/record-order.js';

const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' });
const day = value => formatter.format(new Date(value));
const ids = groups => groups.flatMap(group => group.records.map(record => record.id));
const records = [
  { id: 'monday-original', kind: 'audio', capturedAt: '2026-11-09T10:00:00+09:00', uploadedAt: '2026-11-09T10:01:00+09:00' },
  { id: 'wednesday', kind: 'video', capturedAt: '2026-11-11T10:00:00+09:00', uploadedAt: '2026-11-11T10:01:00+09:00' },
  { id: 'monday-delayed', kind: 'audio', capturedAt: '2026-11-09T09:00:00+09:00', uploadedAt: '2026-11-11T12:00:00+09:00' }
];

test('late offline upload is first without changing its recorded date or pulling all Monday records ahead', () => {
  const before = structuredClone(records);
  const groups = timelineGroups(records, {}, day);
  assert.deepEqual(ids(groups), ['monday-delayed', 'wednesday', 'monday-original']);
  assert.deepEqual(groups.map(group => group.date), ['2026-11-09', '2026-11-11', '2026-11-09']);
  assert.deepEqual(records, before);
});

test('recorded-date order groups newer days first, keeping later uploads first within a day', () => {
  const groups = timelineGroups(records, { order: 'date' }, day);
  assert.deepEqual(ids(groups), ['wednesday', 'monday-delayed', 'monday-original']);
  assert.deepEqual(groups.map(group => group.date), ['2026-11-11', '2026-11-09']);
});

test('manual update wins over upload time; kind and recorded-day filters still apply', () => {
  const edited = records.map(record => record.id === 'monday-original'
    ? { ...record, updatedAt: '2026-11-12T00:30:00+09:00' } : record);
  assert.deepEqual(ids(timelineGroups(edited, {}, day)), ['monday-original', 'monday-delayed', 'wednesday']);
  assert.deepEqual(ids(timelineGroups(edited, { filter: 'audio', date: '2026-11-09' }, day)), ['monday-original', 'monday-delayed']);
  assert.deepEqual(timelineGroups(edited, { filter: 'video', date: '2026-11-09' }, day), []);
});

test('offline drafts and legacy caches fall back to capture time, using real instants and Seoul dates', () => {
  const local = [
    { id: 'older', kind: 'video', capturedAt: '2026-11-11T23:30:00+09:00' },
    { id: 'newer', kind: 'audio', capturedAt: '2026-11-11T15:30:00Z', updatedAt: 'invalid' },
    { id: 'tie-a', kind: 'audio', capturedAt: '2026-11-11T15:30:00Z' }
  ];
  const groups = timelineGroups(local, {}, day);
  assert.deepEqual(ids(groups), ['tie-a', 'newer', 'older']);
  assert.deepEqual(groups.map(group => group.date), ['2026-11-12', '2026-11-11']);
  assert.deepEqual(ids(timelineGroups([...local].reverse(), {}, day)), ids(groups));
});
