import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3"
import { eq } from "drizzle-orm"
import path from "node:path"

import { db, games } from "@/lib/db/client"
import { readRuntimeFiles } from "@/lib/games/seed"
import { elapsed, logger } from "@/lib/observability"
import { GAME_BUNDLE_BUCKET, GAME_BUNDLE_PREFIX, s3 } from "@/lib/storage/client"

// How many objects one DeleteObjects call can name. The API caps a batch at a
// thousand, so anything larger has to be chunked.
const DELETE_BATCH = 1000

/**
 * The object key of one file inside a game's bundle.
 *
 * Prefixes are the only structure S3 has, so a "directory" is a key prefix and
 * a file is the exact key — a path can't be both, which is what the
 * `kind` checks throughout this module lean on.
 */
function objectKey(gameId: string, relPath: string): string {
  return path.posix.join(GAME_BUNDLE_PREFIX, gameId, relPath)
}

/**
 * The key prefix covering one directory of a game's bundle, trailing slash
 * included so it can only match keys under that directory.
 *
 * No `dir` (the bundle root) is the whole game namespace; the trailing slash
 * also keeps a listing from matching a hypothetical `games/{gameId}-other`
 * prefix, and the same trick prevents `src` from matching `src-extra`.
 */
function bundlePrefix(gameId: string, dir?: string): string {
  const base = `${GAME_BUNDLE_PREFIX}/${gameId}/`

  if (!dir || dir === ".") {
    return base
  }

  return `${base}${dir}/`
}

/** Whether a thrown S3 error is the "no such object" NotFound. */
function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    ((error as { name?: unknown }).name === "NotFound" ||
      (error as { $metadata?: { httpStatusCode?: number } }).$metadata
        ?.httpStatusCode === 404)
  )
}

/**
 * Seeds a new game's bundle with the files in `@/lib/games/runtime`, and
 * records on the row that the game has a bundle.
 *
 * One of the runtime files is a placeholder page, so the game has something
 * servable from its very first moment, before the agent has written any code.
 *
 * The row is updated last: a row that has a `bundleInitializedAt` therefore
 * always names a bundle that is fully seeded, and a crash in between leaves a
 * half-seeded bundle behind rather than a game claiming to have one.
 * Seeding again is safe — it is the same handful of small files written over
 * the same keys — so the retry path is just this function once more.
 */
export async function initGameBundle(gameId: string): Promise<void> {
  const startedAt = performance.now()
  const files = await readRuntimeFiles()

  await Promise.all(
    files.map((file) =>
      s3.send(
        new PutObjectCommand({
          Bucket: GAME_BUNDLE_BUCKET,
          Key: objectKey(gameId, file.path),
          Body: file.content,
          ContentType: contentTypeFor(file.path),
          // The player iterates a game live — every reload after a turn has to
          // see the latest build — so nothing the agent writes may sit in an
          // edge cache. `no-cache` lets caches revalidate rather than serve a
          // stale bundle, which is exactly the trade the preview wants.
          CacheControl: "no-cache, must-revalidate",
        })
      )
    )
  )

  await db
    .update(games)
    .set({ bundleInitializedAt: new Date() })
    .where(eq(games.id, gameId))

  // The one place a bundle comes into existence, and the step that gates the
  // preview — a seeding that has crept from seconds to a minute is visible
  // here and nowhere else, which is why the duration is on it.
  logger.info(logger.fmt`Seeded the bundle for game ${gameId}`, {
    "game.id": gameId,
    "bundle.objects": files.length,
    duration_ms: elapsed(startedAt),
  })
}

/** A bundle path's metadata: a file, a directory, or nothing at all. */
export type BundlePathInfo =
  | { kind: "file"; size: number }
  | { kind: "directory" }
  | null

/**
 * What one path in a game's bundle holds, or `null` when there is nothing
 * there.
 *
 * A flat key store means "does this directory exist" is answered by listing
 * its prefix rather than by stat-ing a directory object, so a HeadObject that
 * comes back empty falls through to that before declaring the path missing.
 */
export async function statBundlePath(
  gameId: string,
  relPath: string
): Promise<BundlePathInfo> {
  try {
    const { ContentLength } = await s3.send(
      new HeadObjectCommand({
        Bucket: GAME_BUNDLE_BUCKET,
        Key: objectKey(gameId, relPath),
      })
    )

    return { kind: "file", size: ContentLength ?? 0 }
  } catch (error) {
    if (!isNotFound(error)) {
      throw error
    }

    if (await directoryExists(gameId, relPath)) {
      return { kind: "directory" }
    }

    return null
  }
}

async function directoryExists(gameId: string, relPath: string): Promise<boolean> {
  const { KeyCount } = await s3.send(
    new ListObjectsV2Command({
      Bucket: GAME_BUNDLE_BUCKET,
      Prefix: bundlePrefix(gameId, relPath),
      MaxKeys: 1,
    })
  )

  return (KeyCount ?? 0) > 0
}

/** A file's contents, decoded as utf8. The caller checked it is a file first. */
export async function readBundleFile(
  gameId: string,
  relPath: string
): Promise<string> {
  const { Body } = await s3.send(
    new GetObjectCommand({
      Bucket: GAME_BUNDLE_BUCKET,
      Key: objectKey(gameId, relPath),
    })
  )

  return (await Body?.transformToString("utf8")) ?? ""
}

/**
 * Writes a file into the game's bundle, creating it or replacing it whole.
 *
 * The content-type rides along on every write — a browser will not run a
 * module script served as octet-stream, so the type has to be decided at write
 * time rather than patched at the edge later.
 */
export async function writeBundleFile(
  gameId: string,
  relPath: string,
  content: string
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: GAME_BUNDLE_BUCKET,
      Key: objectKey(gameId, relPath),
      Body: Buffer.from(content, "utf8"),
      ContentType: contentTypeFor(relPath),
      CacheControl: "no-cache, must-revalidate",
    })
  )
}

/** One file in a game's bundle, as `list` reports it. */
export type BundleEntry = { path: string; size: number }

/**
 * Every file under one directory of the game's bundle, addressed relative to
 * the bundle root.
 *
 * `maxDepth` caps how deep the listing reaches, counting from the bundle root
 * — `index.html` is depth one, `engine/index.js` depth two — so a subdirectory
 * listing shows its own files and one level of structure beyond them, the same
 * way `list_files` bounded the sandbox walk it replaced.
 */
export async function listBundleFiles(
  gameId: string,
  dir: string | undefined,
  maxDepth: number
): Promise<BundleEntry[]> {
  const prefix = bundlePrefix(gameId, dir)
  const entries: BundleEntry[] = []

  // S3 pages listings, so this walks pages rather than trusting one response.
  let token: string | undefined

  do {
    const { Contents, NextContinuationToken } = await s3.send(
      new ListObjectsV2Command({
        Bucket: GAME_BUNDLE_BUCKET,
        Prefix: prefix,
        ContinuationToken: token,
      })
    )

    for (const object of Contents ?? []) {
      const relPath = object.Key?.slice(prefix.length) ?? ""

      if (!relPath || relPath.split("/").length > maxDepth) {
        continue
      }

      entries.push({ path: relPath, size: object.Size ?? 0 })
    }

    token = NextContinuationToken
  } while (token)

  return entries.sort((a, b) => a.path.localeCompare(b.path))
}

/** What removing one path from the bundle did, or `null` if nothing was there. */
export type BundleDeleteResult =
  | { kind: "file" }
  | { kind: "directory"; deleted: number }
  | null

/**
 * Removes a file, or — when the path names a directory — every file under it.
 *
 * Which of the two it is decides itself: an exact key is a file, a prefix
 * with objects beneath it is a directory, and neither means there was nothing
 * to delete.
 */
export async function deleteBundlePath(
  gameId: string,
  relPath: string
): Promise<BundleDeleteResult> {
  const info = await statBundlePath(gameId, relPath)

  if (!info) {
    return null
  }

  if (info.kind === "file") {
    await s3.send(
      new DeleteObjectCommand({
        Bucket: GAME_BUNDLE_BUCKET,
        Key: objectKey(gameId, relPath),
      })
    )

    return { kind: "file" }
  }

  const keys = await listObjectKeys(bundlePrefix(gameId, relPath))

  await deleteObjects(keys)

  return { kind: "directory", deleted: keys.length }
}

/**
 * Removes a game's whole bundle, and reports how many objects went.
 *
 * Deleting nothing (a game whose bundle was never seeded) is a success with a
 * count of zero — there is nothing left of a bundle that never existed.
 */
export async function deleteGameBundle(gameId: string): Promise<number> {
  const startedAt = performance.now()

  const keys = await listObjectKeys(bundlePrefix(gameId))

  await deleteObjects(keys)

  // The counterpart to the seed log, and the only place a bundle delete is
  // visible: an object count here is how much of the game was actually on
  // disk, which is worth being able to see at a glance.
  logger.info(logger.fmt`Deleted ${keys.length} objects of game ${gameId}'s bundle`, {
    "game.id": gameId,
    "bundle.deleted": keys.length,
    duration_ms: elapsed(startedAt),
  })

  return keys.length
}

/** Every object key under a prefix, walked across listing pages. */
async function listObjectKeys(prefix: string): Promise<string[]> {
  const keys: string[] = []

  let token: string | undefined

  do {
    const { Contents, NextContinuationToken } = await s3.send(
      new ListObjectsV2Command({
        Bucket: GAME_BUNDLE_BUCKET,
        Prefix: prefix,
        ContinuationToken: token,
      })
    )

    for (const object of Contents ?? []) {
      if (object.Key) {
        keys.push(object.Key)
      }
    }

    token = NextContinuationToken
  } while (token)

  return keys
}

async function deleteObjects(keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += DELETE_BATCH) {
    const batch = keys.slice(i, i + DELETE_BATCH)

    await s3.send(
      new DeleteObjectsCommand({
        Bucket: GAME_BUNDLE_BUCKET,
        Delete: {
          Objects: batch.map((Key) => ({ Key })),
          Quiet: true,
        },
      })
    )
  }
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
}

/** The content-type a file is served as, from its extension. */
function contentTypeFor(filePath: string): string {
  const ext = path.posix.extname(filePath).toLowerCase()

  return CONTENT_TYPES[ext] ?? "application/octet-stream"
}