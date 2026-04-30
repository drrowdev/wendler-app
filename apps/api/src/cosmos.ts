import { CosmosClient, type Container } from '@azure/cosmos';

let containerPromise: Promise<Container> | null = null;

/**
 * Lazily get the Cosmos container holding all sync documents.
 * Connection is configured via env: COSMOS_CONNECTION_STRING (or COSMOS_ENDPOINT + COSMOS_KEY).
 * Container name and database name default to "wendler" / "sync".
 *
 * Returns null when no Cosmos credentials are configured — callers should
 * respond with 503 Service Unavailable so the client knows sync is disabled.
 */
export async function getSyncContainer(): Promise<Container | null> {
  if (containerPromise) return containerPromise;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  const endpoint = process.env.COSMOS_ENDPOINT;
  const key = process.env.COSMOS_KEY;
  if (!conn && !(endpoint && key)) return null;

  const dbName = process.env.COSMOS_DB_NAME ?? 'wendler';
  const containerName = process.env.COSMOS_CONTAINER_NAME ?? 'sync';

  containerPromise = (async () => {
    const client = conn
      ? new CosmosClient(conn)
      : new CosmosClient({ endpoint: endpoint!, key: key! });
    const { database } = await client.databases.createIfNotExists({ id: dbName });
    const { container } = await database.containers.createIfNotExists({
      id: containerName,
      partitionKey: { paths: ['/userId'] },
      indexingPolicy: {
        indexingMode: 'consistent',
        automatic: true,
        includedPaths: [{ path: '/*' }],
        excludedPaths: [{ path: '/payload/*' }, { path: '/_etag/?' }],
      },
    });
    return container;
  })();
  return containerPromise;
}

/**
 * Document shape stored in Cosmos. Each domain mutation is one document.
 * Append-only: clients never update existing documents in place — they append
 * an "amendment" doc whose payload references amendsId.
 */
export interface SyncDoc {
  id: string;            // Cosmos document id == "{userId}::{kind}::{recordId}::{updatedAt}"
  userId: string;        // partition key
  kind:
    | 'set'
    | 'session'
    | 'movement'
    | 'block'
    | 'trainingMax'
    | 'settings'
    | 'schedule'
    | 'goal'
    | 'cardio'
    | 'recovery'
    | 'stravaAuth';
  recordId: string;      // domain entity id ("singleton" for settings/schedule)
  updatedAt: string;     // ISO timestamp set by client
  serverTime: string;    // ISO timestamp set by server on insert
  payload: unknown;      // the full domain object as authored on the client
  deviceId?: string;     // free-form device tag
  schemaVersion: number; // db-schema SCHEMA_VERSION at write time
}
