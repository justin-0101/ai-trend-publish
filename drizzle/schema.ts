import { mysqlTable, mysqlSchema, AnyMySqlColumn, primaryKey, int, varchar } from "drizzle-orm/mysql-core"
import { sql } from "drizzle-orm"

export const config = mysqlTable("config", {
	id: int().autoincrement().notNull(),
	key: varchar({ length: 255 }),
	value: varchar({ length: 255 }),
},
(table) => [
	primaryKey({ columns: [table.id], name: "config_id"}),
]);

export const dataSources = mysqlTable("data_sources", {
	id: int().autoincrement().notNull(),
	platform: varchar({ length: 255 }),
	identifier: varchar({ length: 255 }),
},
(table) => [
	primaryKey({ columns: [table.id], name: "data_sources_id"}),
]);
