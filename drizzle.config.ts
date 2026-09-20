import { config } from "dotenv"

config({ path: ".env.local" })

import { defineConfig } from "drizzle-kit"

// Direct (unpooled) connection — schema pushes hit the Aurora writer directly.
const databaseUrl =
  process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL

if (!databaseUrl) {
  throw new Error("set DATABASE_URL (or DATABASE_URL_UNPOOLED) in .env.local")
}

export default defineConfig({
  schema: "./lib/db/schema.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: databaseUrl,
  },
})
