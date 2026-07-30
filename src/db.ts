import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { getConfig } from "./lib/config";

export type Db = Database.Database;

let dbInstance: Db | null = null;

export function getDb(dbPath?: string): Db {
  if (dbInstance) return dbInstance;
  const resolved = path.resolve(dbPath ?? getConfig().DATABASE_PATH);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new Database(resolved);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  dbInstance = db;
  return db;
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

export function resetDbForTests(dbPath: string): Db {
  closeDb();
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  for (const suffix of ["-wal", "-shm"]) {
    const p = `${dbPath}${suffix}`;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  const db = getDb(dbPath);
  migrate(db);
  return db;
}

export function migrate(db: Db = getDb()): void {
  const schemaPath = path.resolve(process.cwd(), "db/schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf8");
  db.exec(sql);
}

export function withImmediateTransaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
