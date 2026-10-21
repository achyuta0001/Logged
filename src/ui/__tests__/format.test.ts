// @ts-nocheck -- node:test types are not part of the browser tsconfig
// Run: node --test src/ui/__tests__/   (Node >= 22.6 strips TS types natively; no deps)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeHref } from '../format.ts';

test('safeHref keeps http(s) links, escaped for an attribute', () => {
  assert.equal(safeHref('https://www.deccanherald.com/a?b=1&c=2'), 'https://www.deccanherald.com/a?b=1&amp;c=2');
  assert.equal(safeHref('http://example.org/x y'), 'http://example.org/x%20y');
  assert.equal(safeHref('https://example.org/"><img src=x>'), 'https://example.org/%22%3E%3Cimg%20src=x%3E');
});

test('safeHref drops script and data schemes, relative and malformed URLs', () => {
  for (const u of ['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:x', '/data/x', 'not a url', '', undefined]) {
    assert.equal(safeHref(u), null, String(u));
  }
});
