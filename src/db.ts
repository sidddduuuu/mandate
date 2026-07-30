import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const schema = readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8");

export function openDatabase(path: string): DatabaseSync {
  if (!path) {
    throw new TypeError("Database path is required");
  }

  const database = new DatabaseSync(path, {
    allowBareNamedParameters: false,
    allowUnknownNamedParameters: false,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
    timeout: 5_000,
  });

  database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  return database;
}

export function initializeDatabase(path: string): DatabaseSync {
  const database = openDatabase(path);

  try {
    database.exec(schema);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function withImmediateTransaction<T>(
  database: DatabaseSync,
  work: () => T,
): T {
  database.exec("BEGIN IMMEDIATE");

  try {
    const result = work();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    if (database.isTransaction) {
      database.exec("ROLLBACK");
    }
    throw error;
  }
}
