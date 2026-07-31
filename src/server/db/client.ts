import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

const DEVELOPMENT_DATABASE_URL =
  "postgres://openvac:openvac@127.0.0.1:5432/openvac";

function resolveDatabaseUrl() {
  const configured = process.env.DATABASE_URL?.trim();

  if (configured) {
    return configured;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("DATABASE_URL is required in production");
  }

  return DEVELOPMENT_DATABASE_URL;
}

function parsePoolSize() {
  const value = Number.parseInt(process.env.DATABASE_POOL_SIZE ?? "10", 10);
  return Number.isSafeInteger(value) && value > 0 ? value : 10;
}

type SqlClient = ReturnType<typeof postgres>;
type Database = ReturnType<typeof drizzle<typeof schema>>;

const globalDatabase = globalThis as typeof globalThis & {
  __openVacPostgresClient?: SqlClient;
  __openVacDatabase?: Database;
};

export const sqlClient =
  globalDatabase.__openVacPostgresClient ??
  postgres(resolveDatabaseUrl(), {
    max: parsePoolSize(),
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false
  });

export const db =
  globalDatabase.__openVacDatabase ??
  drizzle(sqlClient, {
    schema,
    casing: "snake_case"
  });

if (process.env.NODE_ENV !== "production") {
  globalDatabase.__openVacPostgresClient = sqlClient;
  globalDatabase.__openVacDatabase = db;
}

export type OpenVacDatabase = typeof db;
