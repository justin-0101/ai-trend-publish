import { drizzle } from "npm:drizzle-orm/mysql2";
import mysql from "npm:mysql2/promise";
import { config, dataSources } from "./schema.ts";
import dotenv from "npm:dotenv";

dotenv.config();

const logger = {
  info: (...args: unknown[]) => console.log(...args),
  error: (...args: unknown[]) => console.error(...args)
};

const poolConnection = mysql.createPool({
  host: Deno.env.get("DB_HOST"),
  port: Number(Deno.env.get("DB_PORT")),
  user: Deno.env.get("DB_USER"),
  password: Deno.env.get("DB_PASSWORD"),
  database: Deno.env.get("DB_DATABASE"),
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
});

const db = drizzle(poolConnection, {
  mode: "default",
  schema: {
    config: config,
    dataSources: dataSources,
  },
});

export { poolConnection };
export default db;
