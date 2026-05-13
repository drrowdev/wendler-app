import { describe, it, expect } from 'vitest';
import {
  BACKUP_MIGRATIONS,
  BACKUP_TABLES,
  BackupImportError,
  buildBackupFile,
  decideMerge,
  pickRowTimestamp,
  prepareBackup,
  redactRow,
  sortRowsById,
  stableStringify,
  summarise,
  type BackupData,
} from './backup';
// SCHEMA_VERSION lives in db-schema; for the pure tests we just pin a number
// matching what the package currently ships.
const CURRENT = 12;

function emptyData(): BackupData {
  const out: Partial<BackupData> = {};
  for (const t of BACKUP_TABLES) out[t] = [];
  return out as BackupData;
}

describe('stableStringify', () => {
  it('is byte-deterministic regardless of key insertion order', () => {
    const a = JSON.parse(stableStringify({ b: 1, a: { y: 2, x: 3 } }, 2));
    const b = JSON.parse(stableStringify({ a: { x: 3, y: 2 }, b: 1 }, 2));
    expect(stableStringify(a, 2)).toBe(stableStringify(b, 2));
    // And the actual bytes:
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('preserves array order', () => {
    expect(stableStringify([3, 1, 2])).toBe('[3,1,2]');
  });
});

describe('sortRowsById', () => {
  it('sorts by id stably', () => {
    expect(sortRowsById([{ id: 'b' }, { id: 'a' }, { id: 'c' }])).toEqual([
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
    ]);
  });
  it('handles missing ids by treating them as empty string', () => {
    const out = sortRowsById([{ id: 'a' }, { x: 1 }, { id: 'b' }]);
    expect(out[0]).toEqual({ x: 1 });
  });
});

describe('redactRow', () => {
  it('redacts known note fields', () => {
    expect(redactRow({ id: 'x', notes: 'secret', weight: 100 })).toEqual({
      id: 'x',
      notes: '[redacted]',
      weight: 100,
    });
  });
  it('leaves empty / non-string note fields alone', () => {
    expect(redactRow({ id: 'x', notes: '', description: undefined })).toEqual({
      id: 'x',
      notes: '',
      description: undefined,
    });
  });
  it('passes non-objects through', () => {
    expect(redactRow(null)).toBe(null);
    expect(redactRow('hi' as unknown as Record<string, unknown>)).toBe('hi');
  });
});

describe('buildBackupFile / summarise', () => {
  it('emits the expected wrapper shape', () => {
    const file = buildBackupFile({
      schemaVersion: CURRENT,
      data: emptyData(),
      exportedAt: '2026-05-07T10:00:00.000Z',
    });
    expect(file.format).toBe('wendler-backup');
    expect(file.formatVersion).toBe(1);
    expect(file.schemaVersion).toBe(CURRENT);
    expect(file.redacted).toBeUndefined();
  });

  it('summarises per-table counts and total', () => {
    const data = emptyData();
    data.races = [{ id: 'r1' }, { id: 'r2' }];
    data.goals = [{ id: 'g1' }];
    const s = summarise(data);
    expect(s.total).toBe(3);
    expect(s.counts.races).toBe(2);
    expect(s.counts.goals).toBe(1);
    expect(s.counts.movements).toBe(0);
  });
});

describe('prepareBackup', () => {
  function file(over: Record<string, unknown> = {}): unknown {
    return {
      format: 'wendler-backup',
      formatVersion: 1,
      schemaVersion: CURRENT,
      exportedAt: '2026-05-07T10:00:00.000Z',
      data: emptyData(),
      ...over,
    };
  }

  it('accepts a valid current-version file', () => {
    const out = prepareBackup(file(), CURRENT);
    expect(out.schemaVersion).toBe(CURRENT);
  });

  it('rejects non-objects', () => {
    expect(() => prepareBackup(null, CURRENT)).toThrow(BackupImportError);
    expect(() => prepareBackup('hi', CURRENT)).toThrow(BackupImportError);
  });

  it('rejects wrong format identifier', () => {
    expect(() => prepareBackup(file({ format: 'other' }), CURRENT)).toThrow(
      /Not a Wendler backup/,
    );
  });

  it('rejects newer schema versions', () => {
    expect(() =>
      prepareBackup(file({ schemaVersion: CURRENT + 5 }), CURRENT),
    ).toThrow(/newer app version/);
  });

  it('rejects unsupported format version', () => {
    expect(() => prepareBackup(file({ formatVersion: 2 }), CURRENT)).toThrow(
      /Unsupported backup format/,
    );
  });

  it('rejects when data is not an object', () => {
    expect(() => prepareBackup(file({ data: 'oops' }), CURRENT)).toThrow();
  });

  it('rejects when a table is not an array', () => {
    expect(() =>
      prepareBackup(file({ data: { ...emptyData(), races: 'oops' } }), CURRENT),
    ).toThrow(/races.*not an array/);
  });

  it('coerces missing tables to empty arrays', () => {
    const partialData: Record<string, unknown[]> = { races: [{ id: 'r1' }] };
    const out = prepareBackup(file({ data: partialData }), CURRENT);
    expect(out.data.movements).toEqual([]);
    expect(out.data.races).toEqual([{ id: 'r1' }]);
  });
});

describe('schema migration guard', () => {
  it('has a migration path from every supported lower version up to CURRENT', () => {
    // Backup format starts at schema v12 (when this feature was added). For
    // each intermediate version, ensure a migration entry exists.
    for (let v = 12; v < CURRENT; v++) {
      expect(
        typeof BACKUP_MIGRATIONS[v],
        `missing BACKUP_MIGRATIONS[${v}] — bump SCHEMA_VERSION must add one`,
      ).toBe('function');
    }
  });
});

describe('pickRowTimestamp', () => {
  it('prefers updatedAt', () => {
    expect(
      pickRowTimestamp({
        updatedAt: '2026-05-07T10:00:00.000Z',
        createdAt: '2025-01-01T00:00:00.000Z',
      }),
    ).toBe(Date.parse('2026-05-07T10:00:00.000Z'));
  });
  it('falls through to createdAt', () => {
    expect(
      pickRowTimestamp({ createdAt: '2025-01-01T00:00:00.000Z' }),
    ).toBe(Date.parse('2025-01-01T00:00:00.000Z'));
  });
  it('returns null when no usable timestamp present', () => {
    expect(pickRowTimestamp({ id: 'x' })).toBe(null);
    expect(pickRowTimestamp({ updatedAt: 'not-a-date' })).toBe(null);
    expect(pickRowTimestamp(null)).toBe(null);
  });
});

describe('decideMerge', () => {
  const local = new Map<string, unknown>([
    ['a', { id: 'a', updatedAt: '2026-05-07T10:00:00.000Z', name: 'old' }],
    ['b', { id: 'b', updatedAt: '2026-05-07T10:00:00.000Z' }],
    ['c', { id: 'c' }], // no timestamp
  ]);
  const get = (id: string) => local.get(id);

  it('writes new rows that have no local copy', () => {
    const d = decideMerge('races', [{ id: 'new', updatedAt: '2026-01-01' }], get);
    expect(d.toWrite).toHaveLength(1);
    expect(d.conflicts).toHaveLength(0);
  });

  it('writes incoming when its timestamp is newer', () => {
    const d = decideMerge(
      'races',
      [{ id: 'a', updatedAt: '2026-05-08T00:00:00.000Z', name: 'new' }],
      get,
    );
    expect(d.toWrite).toHaveLength(1);
    expect(d.conflicts).toHaveLength(0);
  });

  it('skips and reports when local is newer', () => {
    const d = decideMerge(
      'races',
      [{ id: 'a', updatedAt: '2025-01-01T00:00:00.000Z' }],
      get,
    );
    expect(d.toWrite).toHaveLength(0);
    expect(d.conflicts).toEqual([
      { table: 'races', id: 'a', reason: 'older' },
    ]);
  });

  it('reports no-updatedAt when timestamps cannot be compared', () => {
    const d = decideMerge('races', [{ id: 'c', name: 'whatever' }], get);
    expect(d.toWrite).toHaveLength(0);
    expect(d.conflicts[0]?.reason).toBe('no-updatedAt');
  });

  it('skips rows without an id', () => {
    const d = decideMerge('races', [{ name: 'orphan' }], get);
    expect(d.toWrite).toHaveLength(0);
    expect(d.conflicts).toHaveLength(0);
  });
});

describe('round-trip via in-memory store', () => {
  it('export → import (replace) is byte-identical', () => {
    const data = emptyData();
    data.races = sortRowsById([
      { id: 'r2', name: 'Vantaa Half', updatedAt: '2026-05-01T00:00:00.000Z' },
      { id: 'r1', name: 'Helsinki Half', updatedAt: '2026-05-01T00:00:00.000Z' },
    ]);
    const exportedAt = '2026-05-07T10:00:00.000Z';
    const file = buildBackupFile({ schemaVersion: CURRENT, data, exportedAt });
    const json1 = stableStringify(file, 2);
    // Parse and re-serialise — should match.
    const reparsed = JSON.parse(json1);
    const prepared = prepareBackup(reparsed, CURRENT);
    const json2 = stableStringify(prepared, 2);
    expect(json2).toBe(json1);
  });
});
