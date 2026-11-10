import assert from 'node:assert/strict';
import { test } from 'node:test';
import { textOn } from './color.ts';

test('white text on most colours, black only on light ones', () => {
  for (const c of ['#3b82f6', '#ef4444', '#10b981', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#6366f1', '#64748b', '#a16207', '#1e3a8a']) {
    assert.equal(textOn(c), '#ffffff', c);
  }
  for (const c of ['#f59e0b', '#84cc16', '#ffff00', '#fde68a']) assert.equal(textOn(c), '#000000', c);
});
