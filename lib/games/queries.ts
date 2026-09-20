import "server-only"

import { desc, eq } from "drizzle-orm"

import { db, games, type Game } from "@/lib/db"

/**
 * Every game, newest first.
 *
 * The app has no accounts — it is a single shared workspace, so what one
 * person built everyone can see.
 */
export async function listGames(): Promise<Game[]> {
  return db.select().from(games).orderBy(desc(games.createdAt))
}

// Postgres rejects a malformed uuid with an error rather than an empty result,
// so bad ids from the URL are filtered out before they reach the query.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A single game, or `undefined` when it doesn't exist.
 */
export async function getGame(id: string): Promise<Game | undefined> {
  if (!UUID_RE.test(id)) {
    return undefined
  }

  const [game] = await db
    .select()
    .from(games)
    .where(eq(games.id, id))
    .limit(1)

  return game
}