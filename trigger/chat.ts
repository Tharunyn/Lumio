import { chat, upsertIncomingMessage } from "@trigger.dev/sdk/ai"
import { stepCountIs, streamText } from "ai"
import { z } from "zod"

import { gameModelSettings } from "@/lib/games/agent"
import {
  loadGameMessages,
  saveGameMessages,
  saveGameTurn,
} from "@/lib/games/chat-store"
import { gameInstructions } from "@/lib/games/instructions"
import { DEFAULT_GAME_MODEL_ID, GAME_MODELS } from "@/lib/games/model-catalog"
import { describeError, elapsed, logger } from "@/lib/observability"
import { initGameBundle } from "@/lib/storage/bundles"
import { createGameTools } from "@/lib/games/tools"

// Everything the browser gets to say about a turn, which is the model to run it
// on and nothing else. The id is checked against the catalog rather than taken
// as a string, so a tab naming a model this app doesn't offer — or one that
// doesn't exist — is rejected here instead of at the provider.
//
// Optional at both levels because there is no picker yet: nothing sends client
// data at all today, and a turn with none runs on `DEFAULT_GAME_MODEL_ID`.
const gameClientDataSchema = z
  .object({
    modelId: z.enum(GAME_MODELS.map((model) => model.id)).optional(),
  })
  .optional()

// A turn is a read-edit-read loop over the game's files, so it needs room for
// many steps; the default of one would stop the turn dead after the first tool
// call, before the model has said anything.
const MAX_STEPS = 48

/**
 * A game's chat thread, run as one long-lived task per conversation.
 *
 * A game owns exactly one thread and the chat id is the game id, so the
 * `games` row stays the source of truth for history: `hydrateMessages` reads it
 * back at the top of every turn instead of trusting the copy the browser holds.
 *
 * Authorization happens before a session can exist, in the server actions in
 * `@/lib/games/chat-actions`.
 */
export const gameChat = chat.agent({
  id: "game-chat",
  clientDataSchema: gameClientDataSchema,
  hydrateMessages: async ({ chatId, trigger, incomingMessages }) => {
    const startedAt = performance.now()
    const stored = await loadGameMessages(chatId)

    // Appends a genuinely new user message and no-ops otherwise. A new game is
    // created with its opening prompt already stored, and the client replays
    // that same message to ask for the first reply — this dedupes it by id.
    //
    // Nothing is written here, deliberately. The turn that answers an
    // `ask_player` question arrives as a state advance on a message this row
    // already holds, which is exactly the case this no-ops on, and the runtime
    // only overlays that advance onto the chain *after* this hook returns — so
    // a write from here could never carry the answer. `onTurnStart` persists
    // the merged chain instead, which covers both cases in one statement.
    const appended = upsertIncomingMessage(stored, {
      trigger,
      incomingMessages,
    })

    // The top of every turn, and the one place the thread's size is visible.
    // Message *counts*, never message content: the thread is the player's
    // prompts and the agent's game source, both of which stay out of Sentry.
    //
    // `appended: false` on what should be a new turn is the signature of the
    // dedupe swallowing a real message, which would look to the player like the
    // agent replying to the message before theirs.
    logger.info(logger.fmt`Chat turn starting for game ${chatId}`, {
      "game.id": chatId,
      "chat.stored_messages": stored.length,
      "chat.incoming_messages": incomingMessages.length,
      "chat.appended_incoming": appended,
      duration_ms: elapsed(startedAt),
    })

    return stored
  },
  // Fires once per game, on the first message of its thread — so the bundle is
  // seeded exactly once and is already in S3 before `run` streams a reply.
  onChatStart: async ({ chatId }) => {
    try {
      await initGameBundle(chatId)
    } catch (error) {
      // Fires exactly once per game, and everything the agent does afterwards
      // needs what it builds. Failing here doesn't stop the turn — the file
      // tools write straight to S3 and work from an empty bundle — but it does
      // mean the first turn discovers a game directory without the starter
      // files, which is the explanation for the "The game directory is empty"
      // that follows.
      logger.error(
        logger.fmt`Could not seed the bundle for game ${chatId}`,
        { "game.id": chatId, ...describeError(error) }
      )

      throw error
    }
  },
  // Every turn, and the last point before it starts streaming: the thread is
  // written down here.
  onTurnStart: async ({ chatId, uiMessages }) => {
    // The thread as the runtime has it, which on the turn that answers an
    // `ask_player` question is the only place the player's answer exists yet:
    // the browser ships it as a state advance on a message this row already
    // holds, and the runtime overlays it between `hydrateMessages` and here.
    //
    // Written before the turn rather than after it, because the turn it opens
    // is a build that runs for minutes — and until this lands, a reload reads
    // the row back and puts the same question to the player a second time. A
    // turn that dies part way never reaches `onTurnComplete` and would
    // otherwise leave the answer nowhere.
    await saveGameMessages({ gameId: chatId, messages: uiMessages })
  },
  onTurnComplete: async ({
    chatId,
    uiMessages,
    chatAccessToken,
    lastEventId,
    clientData,
  }) => {
    const startedAt = performance.now()

    try {
      await saveGameTurn({
        gameId: chatId,
        messages: uiMessages,
        chatAccessToken,
        chatLastEventId: lastEventId,
      })
    } catch (error) {
      // The turn's work is already in the bundle by now; this is the write
      // that makes it survive a reload. Losing it strands the thread on the
      // previous turn's cursor, which is the one failure here that the player
      // sees and the agent doesn't.
      logger.error(
        logger.fmt`Could not persist the finished turn for game ${chatId}`,
        {
          "game.id": chatId,
          "chat.messages": uiMessages.length,
          "chat.has_cursor": lastEventId !== undefined,
          ...describeError(error),
        }
      )

      throw error
    }

    // Pairs with the `Chat turn starting` log above: one of each per turn, so a
    // turn that began and never ended is a gap rather than something to infer.
    logger.info(logger.fmt`Chat turn complete for game ${chatId}`, {
      "game.id": chatId,
      "gen_ai.request.model": clientData?.modelId ?? DEFAULT_GAME_MODEL_ID,
      "chat.messages": uiMessages.length,
      // A turn that ends with no cursor cannot be resumed, so a reload
      // replays it — worth being able to count.
      "chat.has_cursor": lastEventId !== undefined,
      duration_ms: elapsed(startedAt),
    })
  },
  // Resolved per turn rather than declared once, because the tools have to
  // write into this game's bundle: the chat id is the game id, so each turn's
  // set is closed over the right one and the model never names a game itself.
  // Declared on the config and handed back to `streamText` below, rather than
  // only passed there: history re-converted at the top of a later turn needs
  // the same set to make sense of the tool calls already in it.
  tools: ({ chatId }) => createGameTools(chatId),
  run: async ({ messages, tools, signal, clientData, chatId }) => {
    // Read per turn rather than fixed for the thread, so switching models
    // mid-conversation takes effect on the next message and carries the history
    // with it. Named here rather than inline because the same choice decides
    // what the turn runs on and what it is billed at.
    const modelId = clientData?.modelId ?? DEFAULT_GAME_MODEL_ID

    // A turn with nothing to answer. The history ends on the agent's own reply,
    // which means whatever opened this turn added no message to it — a thread
    // submitted twice, or a tab asking for a reply it has already been given.
    // A trailing assistant message is read as a prefill for the model to carry
    // on from, and these models refuse one outright, so the turn would die at
    // the provider rather than quietly do nothing. Returning no stream ends it
    // here instead: nothing generated, nothing charged, nothing added to the
    // thread.
    if (messages.at(-1)?.role === "assistant") {
      logger.warn(
        logger.fmt`Skipped a turn with nothing to answer for game ${chatId}`,
        {
          "game.id": chatId,
          "chat.messages": messages.length,
        }
      )

      return
    }

    return streamText({
      // Spread first, so every option below still wins. Wires up the
      // `prepareStep` behind compaction, steering and background injection —
      // all of which silently no-op without it.
      ...chat.toStreamTextOptions({ tools }),
      // Spread rather than assigned because what varies with the model is
      // `model` today and may not be only that later.
      ...gameModelSettings(modelId),
      // `instructions`, not the deprecated `system`. Passed here rather than
      // through `chat.prompt.set()` because the prompt is static — there is no
      // per-chat or dashboard-versioned part of it to resolve in a hook.
      instructions: gameInstructions,
      messages,
      // Fires on stop and on cancel. Without it, Stop only updates the UI.
      abortSignal: signal,
      stopWhen: stepCountIs(MAX_STEPS),
    })
  },
})
