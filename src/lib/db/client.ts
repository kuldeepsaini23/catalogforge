import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "@/lib/env";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;

const globalForDb = globalThis as unknown as { __cfPool?: Pool; __cfDb?: Db };

export function getPool(): Pool {
  if (!globalForDb.__cfPool) {
    globalForDb.__cfPool = new Pool({
      connectionString: env().DATABASE_URL,
      max: env().DB_POOL_MAX,
      // Fail fast instead of piling up behind a saturated pool.
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
    });
  }
  return globalForDb.__cfPool;
}

export function getDb(): Db {
  if (!globalForDb.__cfDb) globalForDb.__cfDb = drizzle(getPool(), { schema });
  return globalForDb.__cfDb;
}

export async function closeDb(): Promise<void> {
  const pool = globalForDb.__cfPool;
  globalForDb.__cfPool = undefined;
  globalForDb.__cfDb = undefined;
  await pool?.end();
}

export { schema };
