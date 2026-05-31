/**
 * Backup format types and pure helpers — no Dexie / no IndexedDB. The web
 * app wraps these with the actual table I/O in apps/web/src/lib/backup.ts.
 *
 * Anything that touches data shape (validation, migration, redaction,
 * deterministic ordering) belongs here so it can be unit-tested without
 * a browser environment.
 */

/**
 * Tables included in a backup.
 *
 * Excluded by design (see web layer):
 * - syncMeta   — per-device sync cursors
 * - pushSub    — browser-install-specific push endpoint
 * - strengthHr — Strava-derived HR cache, re-fetchable from Strava
 *
 * Tombstones are included so a restore preserves delete intent for the
 * sync engine.
 *
 * Forward compatibility: when a new table is added, append it here. The
 * importer (`prepareBackup`) defaults missing tables to `[]`, so older
 * backups continue to import with new tables starting empty — no
 * breaking change to existing backup files.
 */
export const BACKUP_TABLES = [
  'movements',
  'trainingMaxes',
  'settings',
  'sets',
  'sessions',
  'blocks',
  'programs',
  'schedule',
  'goals',
  'cardio',
  'cardioPlan',
  'recovery',
  'tombstones',
  'races',
  'wellness',
  'notifications',
  'aiGenerations',
  'chats',
  'userProfile',
  'injuries',
  'weeklyReviews',
] as const;

export type BackupTable = (typeof BACKUP_TABLES)[number];

export type BackupData = Record<BackupTable, unknown[]>;

export interface BackupSummary {
  counts: Record<BackupTable, number>;
  total: number;
}

export interface BackupFile {
  format: 'wendler-backup';
  formatVersion: 1;
  schemaVersion: number;
  exportedAt: string;
  redacted?: boolean;
  data: BackupData;
}

export class BackupImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupImportError';
  }
}

/**
 * Per-source-version migrations. When a new SCHEMA_VERSION ships, add an
 * entry mapping `from -> from+1`. The migration mutates `data` in place.
 *
 * The build-time guard test asserts a path exists from every supported
 * version up to the current one.
 */
export type BackupMigration = (data: BackupData) => void;

export const BACKUP_MIGRATIONS: Record<number, BackupMigration> = {
  // None yet. v12 is the first schema with races and the first that the
  // backup format ships with. When SCHEMA_VERSION goes to 13, add 12 here.
};

/**
 * Stable JSON.stringify with sorted object keys, recursively. Arrays keep
 * their order — callers should sort top-level row arrays themselves
 * (see `sortRowsById`).
 */
export function stableStringify(value: unknown, indent = 0): string {
  return JSON.stringify(value, sortedKeyReplacer, indent || undefined);
}

function sortedKeyReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      sorted[k] = obj[k];
    }
    return sorted;
  }
  return value;
}

export function sortRowsById<T>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    const ax = (a as { id?: string }).id ?? '';
    const bx = (b as { id?: string }).id ?? '';
    return ax < bx ? -1 : ax > bx ? 1 : 0;
  });
}

const NOTE_FIELDS: readonly string[] = [
  'notes',
  'note',
  'description',
  'recoveryNote',
  'sessionNote',
];

const NOTE_FIELDS_SET = new Set(NOTE_FIELDS);

/** Replace free-text fields with [redacted] without touching anything else. */
export function redactRow<T>(row: T): T {
  if (!row || typeof row !== 'object') return row;
  const copy: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  for (const k of Object.keys(copy)) {
    if (NOTE_FIELDS_SET.has(k) && typeof copy[k] === 'string' && copy[k]) {
      copy[k] = '[redacted]';
    }
  }
  return copy as T;
}

export function buildBackupFile(opts: {
  schemaVersion: number;
  data: BackupData;
  redacted?: boolean;
  exportedAt?: string;
}): BackupFile {
  return {
    format: 'wendler-backup',
    formatVersion: 1,
    schemaVersion: opts.schemaVersion,
    exportedAt: opts.exportedAt ?? new Date().toISOString(),
    ...(opts.redacted ? { redacted: true } : {}),
    data: opts.data,
  };
}

export function summarise(data: BackupData): BackupSummary {
  const counts = {} as Record<BackupTable, number>;
  let total = 0;
  for (const t of BACKUP_TABLES) {
    counts[t] = (data[t] ?? []).length;
    total += counts[t];
  }
  return { counts, total };
}

/**
 * Validate a parsed JSON value as a BackupFile and run any required
 * forward-migrations so it matches the running app's schema version.
 *
 * Throws {@link BackupImportError} on malformed input or unsupported
 * schema version.
 */
export function prepareBackup(
  raw: unknown,
  currentSchemaVersion: number,
): BackupFile {
  if (!raw || typeof raw !== 'object') {
    throw new BackupImportError('Backup file is not a JSON object.');
  }
  const obj = raw as Record<string, unknown>;
  if (obj.format !== 'wendler-backup') {
    throw new BackupImportError(
      `Not a Wendler backup file (format=${JSON.stringify(obj.format)}).`,
    );
  }
  if (obj.formatVersion !== 1) {
    throw new BackupImportError(
      `Unsupported backup format version: ${String(obj.formatVersion)}. ` +
        `This app understands version 1.`,
    );
  }
  const schemaVersion = obj.schemaVersion;
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion)) {
    throw new BackupImportError('Backup is missing a numeric schemaVersion.');
  }
  if (schemaVersion > currentSchemaVersion) {
    throw new BackupImportError(
      `Backup was created on a newer app version ` +
        `(schema v${schemaVersion}) than this install (v${currentSchemaVersion}). ` +
        `Update the app and try again.`,
    );
  }
  if (!obj.data || typeof obj.data !== 'object') {
    throw new BackupImportError('Backup is missing the `data` section.');
  }
  const data = obj.data as Record<string, unknown>;
  const normalised = {} as BackupData;
  for (const t of BACKUP_TABLES) {
    const v = data[t];
    if (v === undefined || v === null) {
      normalised[t] = [];
    } else if (!Array.isArray(v)) {
      throw new BackupImportError(`Table "${t}" is not an array in the backup.`);
    } else {
      normalised[t] = v;
    }
  }
  let current = schemaVersion;
  while (current < currentSchemaVersion) {
    const fn = BACKUP_MIGRATIONS[current];
    if (!fn) {
      throw new BackupImportError(
        `No migration available from schema v${current} to v${current + 1}. ` +
          `This is a bug — please report it.`,
      );
    }
    fn(normalised);
    current += 1;
  }
  return buildBackupFile({
    schemaVersion: currentSchemaVersion,
    data: normalised,
    redacted: obj.redacted === true,
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : undefined,
  });
}

/**
 * Pick a usable timestamp for merge-conflict resolution. Order of
 * preference matches what we actually write across the schema.
 */
export function pickRowTimestamp(row: unknown): number | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  for (const k of ['updatedAt', 'performedAt', 'completedAt', 'createdAt']) {
    const v = r[k];
    if (typeof v === 'string') {
      const t = Date.parse(v);
      if (!Number.isNaN(t)) return t;
    }
  }
  return null;
}

export type ImportMode = 'replace' | 'merge';

export interface ImportConflict {
  table: BackupTable;
  id: string;
  reason: 'older' | 'no-updatedAt';
}

export interface ImportPlanStep {
  table: BackupTable;
  /** Rows to write; for replace this is everything, for merge only winners. */
  toWrite: unknown[];
  /** ids to delete first (only set in replace mode → empty here; the
   *  Dexie wrapper handles `clear()` on its own). */
}

export interface MergeDecision {
  table: BackupTable;
  /** Per-table list of rows to write. */
  toWrite: unknown[];
  /** ids skipped because the local copy was newer or untimestamped. */
  conflicts: ImportConflict[];
}

/**
 * Pure merge resolver — given an incoming row set and a function that
 * returns the existing local row by id, decide what to write.
 */
export function decideMerge(
  table: BackupTable,
  incoming: readonly unknown[],
  getExisting: (id: string) => unknown | undefined,
): MergeDecision {
  const toWrite: unknown[] = [];
  const conflicts: ImportConflict[] = [];
  for (const row of incoming) {
    const id = (row as { id?: string }).id;
    if (!id) continue;
    const existing = getExisting(id);
    if (existing === undefined) {
      toWrite.push(row);
      continue;
    }
    const incomingTs = pickRowTimestamp(row);
    const existingTs = pickRowTimestamp(existing);
    if (incomingTs == null || existingTs == null) {
      conflicts.push({ table, id, reason: 'no-updatedAt' });
      continue;
    }
    if (incomingTs > existingTs) {
      toWrite.push(row);
    } else {
      conflicts.push({ table, id, reason: 'older' });
    }
  }
  return { table, toWrite, conflicts };
}
