import { closeDb, getDb, migrate } from "../src/db";

migrate(getDb());
console.log("Database migrated:", process.env.DATABASE_PATH ?? "./data/mandate.db");
closeDb();
