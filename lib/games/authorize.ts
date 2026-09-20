import "server-only"

import * as Sentry from "@sentry/nextjs"

import type { Game } from "@/lib/db"
import { getGame } from "@/lib/games/queries"

/**
 * The check every action that names a game runs first.
 *
 * Server Actions are reachable by direct POST, so the game id arrives from the
 * browser and is checked against the database rather than trusted. The app has
 * no accounts — anyone can act on any game in the shared workspace — so this
 * only verifies that the game exists and hands back the row, which callers
 * that need something on it (the sandbox a delete has to take with it) use
 * instead of reading it twice.
 */
export async function authorizeGame(
  gameId: string,
  action: string
): Promise<{ game: Game }> {
  const game = await getGame(gameId)

  if (!game) {
    Sentry.logger.warn(
      Sentry.logger
        .fmt`Rejected ${action} for game ${gameId} that does not exist`,
      {
        "app.action": action,
        "game.id": gameId,
      }
    )

    throw new Error("Not Found")
  }

  // Tags rather than scope attributes, and for events rather than logs:
  // attributes set on a scope never reach logs, and the logs in the callers
  // name the game explicitly anyway. What this buys is that a throw further
  // down — the Trigger handover, a sandbox that won't delete — arrives already
  // saying which game it was.
  Sentry.getIsolationScope().setTags({
    "app.action": action,
    "game.id": gameId,
  })

  return { game }
}