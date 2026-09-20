import path from "node:path"

import { tool } from "ai"
import { z } from "zod"

import { describeError, elapsed, logger } from "@/lib/observability"
import {
  deleteBundlePath,
  listBundleFiles,
  readBundleFile,
  statBundlePath,
  writeBundleFile,
} from "@/lib/storage/bundles"

// Every path the agent gives is resolved against the game directory, which is
// the whole of what the agent can touch: it is what gets served to the player,
// so nothing outside it can reach the player anyway.
//
// Paths are also restricted to this character set. It covers every filename a
// browser game needs, and it keeps a path safe to use as an S3 object key.
const SAFE_PATH = /^[a-zA-Z0-9._/-]+$/

// Big enough for any hand-written game file and small enough that a stray
// binary or generated blob can't blow up the turn's context.
const MAX_FILE_BYTES = 128_000

// How deep `list_files` walks. Games are a handful of files next to
// index.html, so this reaches every level one could plausibly have.
const LIST_DEPTH = 5

/**
 * The question the agent puts to the player, answered in the UI.
 *
 * Alone among the tools it has no `execute`. The call ends the turn with its
 * result still pending, the player answers it in the chat, and the next turn
 * resumes from their choice — the run suspends while it waits, so they can
 * take as long as they like. That is also why it needs an `outputSchema`:
 * with no execute function to infer a result from, the schema is the only
 * statement of what an answer looks like.
 *
 * Static, so it is declared once here rather than built per game like the file
 * tools — nothing about it depends on which game the answer lands in.
 */
const askPlayer = tool({
  description:
    "Put one design question to the player and wait for their answer. Use it to settle a part of the game they haven't decided yet — on the opening turn, to work out what the game actually is before writing any of it. One question per call: the turn stops here until they pick, then carries on, so ask the next one after this answer rather than folding several into one.",
  inputSchema: z.object({
    // First in the schema so it is generated first: naming the part of the
    // game up front keeps the options on one axis, so the player picks
    // between comparable answers rather than between whole games.
    dimension: z
      .enum(["loop", "goal", "challenge", "controls", "world", "look", "feel"])
      .describe(
        [
          "The part of the game the question is about. Choose it first, then write a question that stays inside it.",
          "- loop: the action the player repeats — what they are doing second to second.",
          "- goal: what they are playing towards — winning, losing, scoring, progressing.",
          "- challenge: what stands in their way, and how hard it pushes.",
          "- controls: what they press, and how the game answers.",
          "- world: setting, theme, and how the space is laid out.",
          "- look: art direction — style, palette, camera, scale.",
          "- feel: pace, weight, juice and sound.",
        ].join("\n")
      ),
    question: z
      .string()
      .describe(
        "The question, in one sentence and in the player's terms — what the game would be, not how it would be built."
      ),
    options: z
      .array(
        z.object({
          id: z
            .string()
            .describe(
              'A short lowercase identifier for the option, unique within this question, e.g. "twin-stick".'
            ),
          label: z
            .string()
            .describe("The option in a few words, the way a button reads."),
          description: z
            .string()
            .describe(
              "One sentence on what picking this would mean for the game."
            ),
        })
      )
      .min(2)
      .max(4)
      .describe(
        "The answers to choose between. Each one a different game you would be happy to build — no filler option, and nothing that asks them to write the answer themselves."
      ),
  }),
  outputSchema: z.object({
    optionId: z.string().describe("The id of the option the player picked."),
    label: z.string().describe("The label of the option the player picked."),
  }),
})

/**
 * The tools the agent builds a game with: the file tools it edits the game
 * through, and `ask_player` for the questions it puts back to the player.
 *
 * Built per game rather than declared once, because every file call has to
 * land in *this* game's bundle and the model never sees a game id — the id is
 * closed over here instead of being an argument the model could get wrong.
 *
 * The bundle lives in S3, and the tools write straight to it — so a saved
 * file *is* the player's build the moment the call lands, with nothing to
 * sync, build or restart in between.
 *
 * Tools report expected failures — a missing file, a path outside the game
 * directory, an ambiguous edit — as ordinary results, so the model reads what
 * went wrong and fixes it on the next step. Anything else (a storage failure,
 * a network error) throws and fails the turn.
 */
export function createGameTools(gameId: string) {
  return {
    read_file: tool({
      description:
        "Read a file from the game directory. Read a file before editing it — what is stored is what the player is running, including everything written on earlier turns.",
      inputSchema: z.object({
        path: z
          .string()
          .describe(
            'Path relative to the game directory, e.g. "index.html" or "src/player.js".'
          ),
      }),
      execute: ({ path: filePath }) =>
        expected("read_file", gameId, filePath, async () => {
          const relPath = resolveGamePath(filePath)
          const info = await statBundlePath(gameId, relPath)

          if (!info) {
            return `No file at ${relPath}.`
          }

          if (info.kind === "directory") {
            return `${relPath} is a directory. Use list_files to see what is in it.`
          }

          if (info.size > MAX_FILE_BYTES) {
            return `${relPath} is ${info.size} bytes, over the ${MAX_FILE_BYTES} byte read limit. Split it into smaller modules.`
          }

          return readBundleFile(gameId, relPath)
        }),
    }),

    write_file: tool({
      description:
        "Write a file in the game directory, creating it or replacing its contents whole. Missing parent directories are created. Use replace_text instead when changing part of an existing file.",
      inputSchema: z.object({
        path: z
          .string()
          .describe(
            'Path relative to the game directory, e.g. "index.html" or "src/player.js".'
          ),
        content: z
          .string()
          .describe("The complete contents of the file, not a fragment."),
      }),
      execute: ({ path: filePath, content }) =>
        expected("write_file", gameId, filePath, async () => {
          const relPath = resolveGamePath(filePath)

          if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
            return `That content is over the ${MAX_FILE_BYTES} byte write limit. Split the file into smaller modules.`
          }

          await writeBundleFile(gameId, relPath, content)

          return `Wrote ${relPath} (${lineCount(content)} lines).`
        }),
    }),

    replace_text: tool({
      description:
        "Replace an exact snippet of text in a file in the game directory. Prefer this over write_file for changes that touch part of a file, so the rest of the game stays exactly as it is.",
      inputSchema: z.object({
        path: z
          .string()
          .describe("Path to the file, relative to the game directory."),
        find: z
          .string()
          .describe(
            "The exact text to replace, including its indentation and line breaks. Must appear exactly once in the file unless replace_all is true — include the surrounding lines to make a short snippet unique."
          ),
        replace: z
          .string()
          .describe(
            "The text to put in its place. An empty string deletes the snippet."
          ),
        replace_all: z
          .boolean()
          .optional()
          .describe(
            "Replace every occurrence instead of requiring exactly one. Use for renames."
          ),
      }),
      execute: ({ path: filePath, find, replace, replace_all: replaceAll }) =>
        expected("replace_text", gameId, filePath, async () => {
          const relPath = resolveGamePath(filePath)

          if (find === "") {
            return "find cannot be empty — pass the exact text to replace."
          }

          const info = await statBundlePath(gameId, relPath)

          if (!info) {
            return `No file at ${relPath}.`
          }

          if (info.kind === "directory") {
            return `${relPath} is a directory. Use list_files to see what is in it.`
          }

          if (info.size > MAX_FILE_BYTES) {
            return `${relPath} is ${info.size} bytes, over the ${MAX_FILE_BYTES} byte limit. Split it into smaller modules.`
          }

          const content = await readBundleFile(gameId, relPath)
          // Splitting on the literal counts occurrences and does the
          // replacement in one pass, with none of `String.replace`'s
          // interpretation of `$&` and friends in the replacement.
          const parts = content.split(find)
          const occurrences = parts.length - 1

          if (occurrences === 0) {
            return `That text isn't in ${relPath}. Read the file and copy the snippet exactly, including indentation.`
          }

          if (occurrences > 1 && !replaceAll) {
            return `That text appears ${occurrences} times in ${relPath}. Include the surrounding lines to pick one out, or set replace_all to change them all.`
          }

          const updated = replaceAll
            ? parts.join(replace)
            : content.replace(find, () => replace)

          await writeBundleFile(gameId, relPath, updated)

          return `Replaced ${occurrences === 1 ? "1 occurrence" : `${occurrences} occurrences`} in ${relPath}.`
        }),
    }),

    list_files: tool({
      description:
        "List the files in the game directory. Use it at the start of a turn to see what the game is made of before changing it.",
      inputSchema: z.object({
        path: z
          .string()
          .optional()
          .describe(
            "Subdirectory to list, relative to the game directory. Defaults to the whole game directory."
          ),
      }),
      execute: ({ path: filePath }) =>
        expected("list_files", gameId, filePath, async () => {
          const relPath = resolveGamePath(filePath ?? ".", { allowRoot: true })
          const dir = relPath === "." ? undefined : relPath
          const files = await listBundleFiles(gameId, dir, LIST_DEPTH)

          if (files.length === 0) {
            return dir === undefined
              ? "The game directory is empty."
              : `No directory at ${relPath}.`
          }

          return files
            .map((file) => `${file.path} (${file.size} bytes)`)
            .join("\n")
        }),
    }),

    delete_file: tool({
      description:
        "Delete a file or directory from the game directory. Only for files the game no longer uses — deleting index.html leaves the preview with nothing to load.",
      inputSchema: z.object({
        path: z
          .string()
          .describe(
            "Path to the file or directory to delete, relative to the game directory."
          ),
      }),
      execute: ({ path: filePath }) =>
        expected("delete_file", gameId, filePath, async () => {
          const relPath = resolveGamePath(filePath)
          const result = await deleteBundlePath(gameId, relPath)

          if (!result) {
            return `No file at ${relPath}.`
          }

          return result.kind === "file"
            ? `Deleted ${relPath}.`
            : `Deleted ${relPath} and everything in it.`
        }),
    }),

    ask_player: askPlayer,
  }
}

/** The tools, as declared on the chat agent. */
export type GameTools = ReturnType<typeof createGameTools>

/**
 * A failure the model can fix by calling the tool differently.
 *
 * Thrown from the helpers so a check can bail from anywhere, and turned back
 * into a plain tool result by `expected` — the model reads it as an answer and
 * corrects course, instead of the turn dying on a rejected tool call.
 */
class ToolInputError extends Error {}

/**
 * Runs a tool call, turning a `ToolInputError` back into a plain result, and
 * logs how it went either way.
 *
 * This is the only path every tool call passes through, which makes it the one
 * place worth logging them from: one wide event per call, carrying the tool,
 * the game, the path it was pointed at and what it cost. That record is the
 * agent's entire effect on a game — the chat thread shows what the model said
 * it did, and this shows what actually reached the bundle.
 *
 * The three outcomes are deliberately three levels. A refused call is a `warn`:
 * the model mis-called the tool and will read the message and correct itself,
 * so it is not a failure of the system, but a stream of them means the tool
 * descriptions are not landing. A thrown call is an `error` and takes the turn
 * down with it.
 */
async function expected(
  tool: string,
  gameId: string,
  target: string | undefined,
  run: () => Promise<string>
): Promise<string> {
  const startedAt = performance.now()

  // `gen_ai.tool.name` and the game id go on every one of these, so a single
  // turn's worth of calls can be pulled up as a group and read in order.
  const attributes: Record<string, string | number | boolean> = {
    "gen_ai.operation.name": "execute_tool",
    "gen_ai.tool.name": tool,
    "game.id": gameId,
  }

  // The path the model asked for, before it is resolved — an argument the
  // model chose, and the thing most worth having when a call went wrong.
  // Contents are never logged: game source stays out of Sentry, in line with
  // the `httpBodies: []` stance in the SDK configs.
  if (target !== undefined && target !== "") {
    attributes["code.file.path"] = target
  }

  try {
    const result = await run()

    logger.info(logger.fmt`Agent called ${tool}`, {
      ...attributes,
      duration_ms: elapsed(startedAt),
    })

    return result
  } catch (error) {
    if (error instanceof ToolInputError) {
      logger.warn(logger.fmt`Agent called ${tool} with unusable input`, {
        ...attributes,
        "tool.refusal": error.message,
        duration_ms: elapsed(startedAt),
      })

      return error.message
    }

    logger.error(logger.fmt`Agent's call to ${tool} failed`, {
      ...attributes,
      ...describeError(error),
      duration_ms: elapsed(startedAt),
    })

    throw error
  }
}

/**
 * Turns a path from the model into the bundle-relative path used for object
 * keys.
 *
 * This is the only place a tool path becomes a real path, so it is also the
 * confinement: an absolute path, a `..` climb or a symlink-ish name all end
 * up measured against the game directory here, and anything landing outside
 * is refused before it reaches storage. The `SAFE_PATH` check doubles as the
 * object-key safety check — a key that passes it is printable, slash-separated
 * and cannot collide with the `games/{gameId}/` namespace boundary.
 */
function resolveGamePath(
  input: string,
  { allowRoot = false }: { allowRoot?: boolean } = {}
): string {
  const trimmed = input.trim()

  if (trimmed === "") {
    throw new ToolInputError("path cannot be empty.")
  }

  if (!SAFE_PATH.test(trimmed)) {
    throw new ToolInputError(
      `"${trimmed}" isn't a usable path. Use letters, digits, dots, dashes, underscores and slashes only.`
    )
  }

  // `a/../b` collapses to `b` and is fine — it stays inside. `../` at the
  // start and anything absolute leave the game directory, so both are refused.
  const normalized = path.posix.normalize(trimmed)

  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/")
  ) {
    throw new ToolInputError(
      `"${trimmed}" is outside the game directory. Every path is relative to the game directory and has to stay inside it.`
    )
  }

  const isRoot = normalized === "."

  if (isRoot && !allowRoot) {
    throw new ToolInputError(
      "That is the game directory itself. Name a file inside it."
    )
  }

  return isRoot ? "." : normalized
}

function lineCount(content: string): number {
  return content === "" ? 0 : content.split("\n").length
}