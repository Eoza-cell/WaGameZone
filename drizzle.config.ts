import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./drizzle",
  schema: "./shared/schema.js",
  dialect: "sqlite",
  dbCredentials: {
    url: "./wazone.db",
  },
});
