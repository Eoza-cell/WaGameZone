import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

export const players = sqliteTable("players", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  health: integer("health").notNull().default(100),
  energy: integer("energy").notNull().default(100),
  money: integer("money").notNull().default(1000),
  currentWeapon: text("current_weapon").notNull().default("pistolet"),
  weapons: text("weapons", { mode: "json" }).notNull().default('["pistolet"]'),
  position: text("position", { mode: "json" }).notNull().default('{"x": 0, "y": 0, "location": "rue"}'),
  isDead: integer("is_dead", { mode: "boolean" }).notNull().default(false),
  deadUntil: real("dead_until"),
  lastRegeneration: real("last_regeneration").notNull().default(Date.now()),
  kills: integer("kills").notNull().default(0),
  deaths: integer("deaths").notNull().default(0),
  killstreak: integer("killstreak").notNull().default(0),
  loadouts: text("loadouts", { mode: "json" }).notNull().default('[{"name": "Default", "primary": "fusil", "secondary": "pistolet"}]'),
  createdAt: real("created_at").notNull().default(Date.now()),
  updatedAt: real("updated_at").notNull().default(Date.now())
});

export const missions = sqliteTable("missions", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  type: text("type").notNull(),
  goal: integer("goal").notNull(),
  reward: integer("reward").notNull()
});

export const playerMissions = sqliteTable("player_missions", {
  id: text("id").primaryKey(),
  playerId: text("player_id").notNull().references(() => players.id),
  missionId: text("mission_id").notNull().references(() => missions.id),
  progress: integer("progress").notNull().default(0),
  isCompleted: integer("is_completed", { mode: "boolean" }).notNull().default(false),
  assignedAt: real("assigned_at").notNull().default(Date.now())
});
