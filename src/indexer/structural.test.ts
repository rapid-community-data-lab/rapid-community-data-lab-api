import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sourcePath = fileURLToPath(new URL('./structural.ts', import.meta.url));
const src = readFileSync(sourcePath, 'utf-8');

describe('StructuralIndexer (regression)', () => {
  it('uses prisma upsert (not create) so re-indexing is idempotent', () => {
    expect(src).toMatch(/prisma\[tableName\]\.upsert\(/);
    expect(src).not.toMatch(/prisma\[tableName\]\.create\(/);
  });

  it('upserts by id (the primary key on Entity and File)', () => {
    expect(src).toMatch(/where:\s*\{\s*id:\s*data\.id\s*\}/);
  });
});

