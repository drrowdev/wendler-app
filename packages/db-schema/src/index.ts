export const SCHEMA_VERSION = 20;

/** Local marker that a record was deleted; pushed to the server so peers also delete. */
export interface Tombstone {
  /** `${kind}:${recordId}` — composite key. */
  id: string;
  kind: string;
  recordId: string;
  /** ISO of the delete. */
  deletedAt: string;
}

export * from './types';
export * from './seed-movements';
