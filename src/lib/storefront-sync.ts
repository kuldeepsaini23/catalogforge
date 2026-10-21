import { Client } from "pg";
import { env } from "@/lib/env";

/**
 * Cross-process storefront invalidation. Every web process keeps its own in-memory cache, so
 * `revalidateTag` in the process that handled "Approve" is not enough. Writers (API routes and the
 * worker) `NOTIFY storefront_changed`; every web process LISTENs and bumps a version per product /
 * category. The version is part of the cache key, so a changed product can never be served stale.
 */
const CHANNEL = "storefront_changed";
const versions = new Map<string, number>();
let epoch = 0;
let listening: Promise<void> | null = null;

export interface StorefrontChange {
  handles?: string[];
  categories?: string[];
  all?: boolean;
}

function apply(change: StorefrontChange): void {
  if (change.all) epoch++;
  for (const h of change.handles ?? []) versions.set(`p:${h}`, (versions.get(`p:${h}`) ?? 0) + 1);
  for (const c of change.categories ?? []) versions.set(`c:${c}`, (versions.get(`c:${c}`) ?? 0) + 1);
  // Any change can alter collection counts/covers.
  versions.set("collections", (versions.get("collections") ?? 0) + 1);
}

function listen(): Promise<void> {
  if (!listening) {
    listening = (async () => {
      const client = new Client({ connectionString: env().DATABASE_URL });
      client.on("notification", (msg) => {
        try {
          apply(JSON.parse(msg.payload ?? "{}") as StorefrontChange);
        } catch {
          epoch++; // unreadable payload: drop everything rather than risk stale pages
        }
      });
      client.on("error", () => {
        // Connection lost: invalidate everything and reconnect on next use.
        epoch++;
        listening = null;
      });
      await client.connect();
      await client.query(`LISTEN ${CHANNEL}`);
    })().catch(() => {
      listening = null;
    });
  }
  return listening;
}

/** Cache-key version for a product / category / the collection index. Starts listening on first use. */
export function versionOf(key: `p:${string}` | `c:${string}` | "collections"): string {
  void listen();
  return `${epoch}.${versions.get(key) ?? 0}`;
}

/** Tells every web process that published data changed. Payloads are chunked under NOTIFY's 8 KB limit. */
export async function notifyStorefront(change: StorefrontChange, query: (sql: string, params: unknown[]) => Promise<unknown>): Promise<void> {
  const handles = change.handles ?? [];
  const chunks: StorefrontChange[] = [];
  for (let i = 0; i < Math.max(1, handles.length); i += 100) {
    chunks.push({ handles: handles.slice(i, i + 100), categories: i === 0 ? change.categories : undefined, all: i === 0 ? change.all : undefined });
  }
  for (const c of chunks) await query("SELECT pg_notify($1, $2)", [CHANNEL, JSON.stringify(c)]);
}
