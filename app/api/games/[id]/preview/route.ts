import * as Sentry from "@sentry/nextjs"

import { getGame } from "@/lib/games/queries"
import { elapsed } from "@/lib/observability"
import { previewUrlFor } from "@/lib/storage/delivery"

/**
 * The url a game's preview iframe loads.
 *
 * The preview panel calls this on mount. Unlike the sandbox-served preview it
 * replaces, nothing has to be woken: the game's bundle sits in S3, so the
 * first load is a signature and a redirect rather than a cold start — the
 * url is ready the moment it is asked for.
 *
 * The url is a CloudFront signed url: short-lived, scoped to an hour, and
 * good for exactly this game's entry point. It is loaded in an iframe, which
 * is why it signs the url itself rather than relying on a cookie or header
 * that a cross-origin iframe cannot send.
 *
 * `getGame` resolves the organization from the session and scopes the lookup to
 * it, so a game belonging to another org — or a caller with no session at all —
 * is indistinguishable from a game that doesn't exist.
 */
export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/games/[id]/preview">
) {
  const startedAt = performance.now()
  const { id } = await ctx.params

  // Tags, for the events rather than the logs — a 500 out of the signer
  // arrives saying which game it was. Scope attributes would not reach the
  // logs below, which carry the game id themselves.
  Sentry.getIsolationScope().setTags({
    "app.route": "GET /api/games/[id]/preview",
    "game.id": id,
  })

  const game = await getGame(id)

  // Deliberately indistinguishable from another org's game, so the log is the
  // only place the difference is recorded — and the one place a player stuck on
  // "Preview is unavailable" can be told apart from someone walking game ids.
  if (!game) {
    Sentry.logger.warn(
      Sentry.logger
        .fmt`Preview requested for game ${id}, which the caller cannot see`,
      { "game.id": id, "http.response.status_code": 404 }
    )

    return Response.json({ error: "Game not found" }, { status: 404 })
  }

  // Null until the thread's first turn seeds the bundle, and for games made
  // before bundles existed. Neither has anything to preview yet.
  if (!game.bundleInitializedAt) {
    // Expected on a brand-new game, so not a warning — but a game still
    // answering 409 well after its first turn finished means `onChatStart`
    // never ran, and this is what shows that.
    Sentry.logger.info(
      Sentry.logger
        .fmt`Preview requested for game ${id} before its bundle was seeded`,
      { "game.id": id, "http.response.status_code": 409 }
    )

    return Response.json({ error: "Game has no bundle yet" }, { status: 409 })
  }

  // A throw from here is a 500, which `onRequestError` in `@/instrumentation`
  // already captures with a stack trace — and signing can only fail on
  // misconfiguration, which the module's import-time checks already made loud.
  const url = previewUrlFor(id)

  // The url is signed, so it is a credential — the game id identifies the
  // same thing without being one.
  Sentry.logger.info(Sentry.logger.fmt`Served preview url for game ${id}`, {
    "game.id": id,
    "bundle.initialized_at": game.bundleInitializedAt.toISOString(),
    "http.response.status_code": 200,
    duration_ms: elapsed(startedAt),
  })

  return Response.json({ url })
}