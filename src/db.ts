import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import {
  Pool,
  type PoolClient,
  type QueryResultRow,
} from "@neondatabase/serverless";

export type Row = Readonly<Record<string, unknown>>;
export type RunResult = Readonly<{ changes: number }>;

export interface Database {
  get<T extends QueryResultRow = Row>(
    sql: string,
    ...parameters: readonly unknown[]
  ): Promise<T | undefined>;
  all<T extends QueryResultRow = Row>(
    sql: string,
    ...parameters: readonly unknown[]
  ): Promise<readonly T[]>;
  run(sql: string, ...parameters: readonly unknown[]): Promise<RunResult>;
  transaction<T>(work: (database: Database) => Promise<T>): Promise<T>;
  close(): void | Promise<void>;
}

export interface TestDatabase extends Database {
  prepare(sql: string): ReturnType<DatabaseSync["prepare"]>;
  exec(sql: string): void;
  readonly isTransaction: boolean;
}

class SqliteDatabase implements TestDatabase {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
    this.#database = new DatabaseSync(path, {
      allowBareNamedParameters: false,
      allowUnknownNamedParameters: false,
      enableDoubleQuotedStringLiterals: false,
      enableForeignKeyConstraints: true,
      timeout: 5_000,
    });
    this.#database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  }

  get isTransaction(): boolean {
    return this.#database.isTransaction;
  }

  prepare(sql: string): ReturnType<DatabaseSync["prepare"]> {
    return this.#database.prepare(sql);
  }

  exec(sql: string): void {
    this.#database.exec(sql);
  }

  async get<T extends QueryResultRow = Row>(
    sql: string,
    ...parameters: readonly unknown[]
  ): Promise<T | undefined> {
    return this.prepare(sqliteSql(sql)).get(...sqliteParameters(parameters)) as
      | T
      | undefined;
  }

  async all<T extends QueryResultRow = Row>(
    sql: string,
    ...parameters: readonly unknown[]
  ): Promise<readonly T[]> {
    return this.prepare(sqliteSql(sql)).all(
      ...sqliteParameters(parameters)
    ) as T[];
  }

  async run(
    sql: string,
    ...parameters: readonly unknown[]
  ): Promise<RunResult> {
    const result = this.prepare(sqliteSql(sql)).run(
      ...sqliteParameters(parameters),
    );
    return Object.freeze({ changes: Number(result.changes) });
  }

  async transaction<T>(
    work: (database: Database) => Promise<T>,
  ): Promise<T> {
    this.exec("BEGIN IMMEDIATE");
    try {
      const result = await work(this);
      this.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.isTransaction) this.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.#database.close();
  }
}

type NeonExecutor = Pool | PoolClient;

class NeonDatabase implements Database {
  readonly #pool: Pool;
  readonly #executor: NeonExecutor;
  readonly #ownsPool: boolean;

  constructor(pool: Pool, client?: PoolClient) {
    this.#pool = pool;
    this.#executor = client ?? pool;
    this.#ownsPool = !client;
  }

  async get<T extends QueryResultRow = Row>(
    sql: string,
    ...parameters: readonly unknown[]
  ): Promise<T | undefined> {
    const result = await this.#executor.query<T>(
      postgresParameters(sql),
      [...parameters],
    );
    return result.rows[0];
  }

  async all<T extends QueryResultRow = Row>(
    sql: string,
    ...parameters: readonly unknown[]
  ): Promise<readonly T[]> {
    const result = await this.#executor.query<T>(
      postgresParameters(sql),
      [...parameters],
    );
    return result.rows;
  }

  async run(
    sql: string,
    ...parameters: readonly unknown[]
  ): Promise<RunResult> {
    const result = await this.#executor.query(
      postgresParameters(sql),
      [...parameters],
    );
    return Object.freeze({ changes: result.rowCount ?? 0 });
  }

  async transaction<T>(
    work: (database: Database) => Promise<T>,
  ): Promise<T> {
    if (!this.#ownsPool) {
      throw new Error("Nested database transactions are not supported");
    }
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(new NeonDatabase(this.#pool, client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if (this.#ownsPool) await this.#pool.end();
  }
}

function sqliteParameters(
  parameters: readonly unknown[],
): Parameters<ReturnType<DatabaseSync["prepare"]>["run"]> {
  return parameters as Parameters<
    ReturnType<DatabaseSync["prepare"]>["run"]
  >;
}

function postgresParameters(sql: string): string {
  let index = 0;
  return sql.replaceAll("?", () => `$${++index}`);
}

function sqliteSql(sql: string): string {
  return sql.replace(/\s+FOR UPDATE\b/giu, "");
}

export function openDatabase(path: string): TestDatabase {
  if (!path) throw new TypeError("Database path is required");
  return new SqliteDatabase(path);
}

export function initializeDatabase(path: string): TestDatabase {
  const database = openDatabase(path);
  try {
    database.exec(
      readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"),
    );
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export async function withDatabase<T>(
  work: (database: Database) => Promise<T>,
): Promise<T> {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const database = new NeonDatabase(
    new Pool({ connectionString, max: 1 }),
  );
  try {
    return await work(database);
  } finally {
    await database.close();
  }
}

export function withImmediateTransaction<T>(
  database: Database,
  work: (database: Database) => Promise<T>,
): Promise<T> {
  return database.transaction(work);
}
