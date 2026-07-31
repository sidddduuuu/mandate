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
  const hasOrders = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'orders'`)
    .get();
  if (hasOrders) {
    const columns = new Set(
      (
        db.prepare(`PRAGMA table_info(orders)`).all() as { name: string }[]
      ).map((column) => column.name),
    );
    for (const [name, type] of [
      ["budget_window_start", "TEXT"],
      ["budget_window_end", "TEXT"],
      ["budget_limit_minor", "INTEGER"],
    ] as const) {
      if (!columns.has(name)) db.exec(`ALTER TABLE orders ADD COLUMN ${name} ${type}`);
    }
    db.exec(
      `UPDATE orders
       SET budget_window_start = (
             SELECT budget_window_start FROM mandates WHERE mandates.id = orders.mandate_id
           ),
           budget_window_end = (
             SELECT budget_window_end FROM mandates WHERE mandates.id = orders.mandate_id
           ),
           budget_limit_minor = (
             SELECT budget_limit_minor FROM mandates WHERE mandates.id = orders.mandate_id
           )
       WHERE budget_window_start IS NULL
          OR budget_window_end IS NULL
          OR budget_limit_minor IS NULL`,
    );
  }
  const schemaPath = path.resolve(process.cwd(), "db/schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf8");
  db.exec(sql);
  db.exec(
    `INSERT OR IGNORE INTO budget_reservations (
       order_id, buyer_org_id, currency, budget_window_start,
       budget_window_end, amount_minor, status, created_at, updated_at
     )
     SELECT id, buyer_org_id, currency, budget_window_start, budget_window_end,
            total_minor,
            CASE
              WHEN status = 'paid' THEN 'consumed'
              WHEN status IN ('awaiting_approval', 'payment_pending', 'payment_failed') THEN 'held'
              ELSE 'released'
            END,
            created_at, updated_at
     FROM orders`,
  );
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
