import { migrate } from "drizzle-orm/node-postgres/migrator";
import { closeDb, getDb } from "./client";

/** Applies Drizzle migrations. Safe to run repeatedly. */
export async function runMigrations(): Promise<void> {
  await migrate(getDb(), { migrationsFolder: "./drizzle" });
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("src/lib/db/migrate.ts");
if (isMain) {
  runMigrations()
    .then(async () => {
      console.log("migrations applied");
      await closeDb();
    })
    .catch(async (err) => {
      console.error(err);
      await closeDb();
      process.exit(1);
    });
}
