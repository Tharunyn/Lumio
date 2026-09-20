import { readFile, readdir } from "node:fs/promises"
import path from "node:path"

// The seed files themselves live in `./runtime`, as the files they are, so
// they can be edited as html/css/js rather than as strings in a module.
//
// Resolved from the process' working directory rather than from this module's
// url: this code runs inside the Trigger.dev worker, so `import.meta.url`
// points at a build artifact, while the working directory is the project root
// in dev and the deployment root in production — both of which `runtime/*`
// keeps its path relative to (see `additionalFiles` in `@/trigger.config`).
const RUNTIME_DIR = path.join(process.cwd(), "lib", "games", "runtime")

/**
 * Every file under `./runtime`, addressed as the object key it belongs at in a
 * game's bundle.
 *
 * The tree is walked rather than listed, so a file added to `runtime/` — at
 * any depth — is seeded without anything here having to learn its name.
 * Contents are read into memory: a bundle's seed is a couple dozen small
 * files, which is not worth streaming.
 */
export async function readRuntimeFiles(): Promise<
  { path: string; content: Buffer }[]
> {
  const entries = await readdir(RUNTIME_DIR, {
    recursive: true,
    withFileTypes: true,
  })

  const files: { path: string; content: Buffer }[] = []

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue
    }

    const source = path.join(entry.parentPath, entry.name)
    // Object keys are posix regardless of what this worker runs on.
    const relativePath = path.relative(RUNTIME_DIR, source).split(path.sep).join("/")

    files.push({ path: relativePath, content: await readFile(source) })
  }

  return files.sort((a, b) => a.path.localeCompare(b.path))
}