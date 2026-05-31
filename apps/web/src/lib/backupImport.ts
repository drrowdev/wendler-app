'use client';

/**
 * Web-side import wrapper. Pure validation/merge logic lives in
 * `@wendler/domain/backup` and is unit-tested there.
 */

import {
  BACKUP_TABLES,
  BackupImportError,
  decideMerge,
  prepareBackup,
  summarise,
  type BackupSummary,
  type BackupTable,
  type ImportConflict,
  type ImportMode,
} from '@wendler/domain';
import { SCHEMA_VERSION } from '@wendler/db-schema';
import type { Table } from 'dexie';
import { getDb } from './db';

export { BackupImportError };
export type { ImportMode, ImportConflict };

export interface ImportOptions {
  mode: ImportMode;
}

export interface ImportResult {
  summary: BackupSummary;
  conflicts: ImportConflict[];
  /** Number of rows actually written (for both modes). */
  written: number;
  mode: ImportMode;
}

export async function importBackup(
  raw: unknown,
  opts: ImportOptions,
): Promise<ImportResult> {
  const file = prepareBackup(raw, SCHEMA_VERSION);
  const db = getDb();
  // Filter out any BACKUP_TABLES entries that don't exist on the live
  // Dexie instance (drift between domain backup list and the runtime
  // schema). Mirrors the defensive guard in exportBackup.
  const tables = BACKUP_TABLES.flatMap((name) => {
    const table = (db as unknown as Record<string, Table<unknown, unknown>>)[name];
    if (!table || typeof (table as { toArray?: unknown }).toArray !== 'function') {
      console.warn(
        `[backup-import] BACKUP_TABLES references "${name}" but it's not on the Dexie instance — skipped.`,
      );
      return [];
    }
    return [{ name, table }];
  });

  const conflicts: ImportConflict[] = [];
  let written = 0;

  await db.transaction(
    'rw',
    tables.map((t) => t.table),
    async () => {
      if (opts.mode === 'replace') {
        for (const { table } of tables) {
          await table.clear();
        }
      }

      for (const { name, table } of tables) {
        const incoming = file.data[name] ?? [];
        if (opts.mode === 'replace') {
          if (incoming.length > 0) {
            await table.bulkPut(incoming);
            written += incoming.length;
          }
          continue;
        }
        // merge — fetch all existing once so we don't issue N round-trips.
        const existingAll = (await table.toArray()) as Array<Record<string, unknown>>;
        const existingMap = new Map<string, unknown>();
        for (const e of existingAll) {
          if (typeof e.id === 'string') existingMap.set(e.id, e);
        }
        const decision = decideMerge(name as BackupTable, incoming, (id) =>
          existingMap.get(id),
        );
        if (decision.toWrite.length > 0) {
          await table.bulkPut(decision.toWrite);
          written += decision.toWrite.length;
        }
        conflicts.push(...decision.conflicts);
      }
    },
  );

  return {
    summary: summarise(file.data),
    conflicts,
    written,
    mode: opts.mode,
  };
}

export async function readBackupFile(file: File): Promise<unknown> {
  const text = await file.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new BackupImportError(
      `File is not valid JSON: ${(e as Error).message}`,
    );
  }
}
