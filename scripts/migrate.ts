import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "@neondatabase/serverless";

export async function migrateDatabase(connectionString: string): Promise<void> {
  if (!connectionString) throw new TypeError("Database URL is required");
  const pool = new Pool({ connectionString, max: 1 });
  try {
    const schema = readFileSync(
      new URL("../db/postgres.sql", import.meta.url),
      "utf8",
    );
    await pool.query(schema);
  } finally {
    await pool.end();
  }
}

async function runCli(): Promise<void> {
  const connectionString = (
    process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL
  )?.trim();
  if (!connectionString) throw new Error("DATABASE_URL is required");
  await migrateDatabase(connectionString);
  console.log("Postgres schema is current");
}

const invokedPath = process.argv[1];
if (
  invokedPath
  && import.meta.url === pathToFileURL(resolve(invokedPath)).href
) {
  runCli().catch((error: unknown) => {
    console.error(
      `Migration failed: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
    process.exitCode = 1;
  });
}
