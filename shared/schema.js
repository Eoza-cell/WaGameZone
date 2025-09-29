import { pgTable, text, integer, timestamp, boolean, jsonb } from "drizzle-orm/pg-core";

export const players = pgTable("players", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  health: integer("health").notNull().default(100),
  energy: integer("energy").notNull().default(100),
  money: integer("money").notNull().default(1000),
  currentWeapon: text("current_weapon").notNull().default("pistolet"),
  weapons: jsonb("weapons").notNull().default(["pistolet"]),
  position: jsonb("position").notNull().default({x: 0, y: 0, location: "rue"}),
  isDead: boolean("is_dead").notNull().default(false),
  deadUntil: timestamp("dead_until"),
  lastRegeneration: timestamp("last_regeneration").notNull().defaultNow(),
  kills: integer("kills").notNull().default(0),
  deaths: integer("deaths").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow()
});
