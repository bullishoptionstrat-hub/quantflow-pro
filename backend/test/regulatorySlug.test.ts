import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { regulatorySource } from '../src/routes/sentiment';

test('an inherited property name is not a regulatory source', () => {
  for (const slug of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf', '__defineGetter__']) {
    assert.equal(regulatorySource(slug), undefined, `${slug} passed the allowlist`);
  }
});

test('an allowlisted slug still resolves to its URL', () => {
  const entry = regulatorySource('finra-trf');
  assert.ok(entry);
  assert.match(entry.url, /^https:\/\/www\.finra\.org\//);
});

test('the route resolves slugs only through the own-property check', () => {
  const src = readFileSync(join(__dirname, '../src/routes/sentiment.ts'), 'utf8');
  assert.match(src, /const entry = regulatorySource\(req\.params\.slug\)/);
  assert.doesNotMatch(src, /REGULATORY_SOURCES\[req\./);
});
