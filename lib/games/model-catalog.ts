/**
 * The models a game can be built with, in the order a picker should offer them.
 *
 * Client-safe on purpose: ids and copy, and nothing that talks to Bedrock. The
 * provider instances live in `./models`, which pulls in the provider SDK and
 * reads the AWS credentials — so a component that only needs to *name* a model
 * never drags either of those into the browser bundle.
 *
 * The ids are this app's own slugs rather than Bedrock's model ids. Bedrock
 * names each model its own way (geo inference profiles, versioned ids), and
 * that mapping is exactly the detail a client should never have to know — so
 * the slug belongs here and the Bedrock model id lives beside the provider
 * instance in `./models`.
 */
export const GAME_MODELS = [
  {
    id: "claude-opus-4-8",
    name: "Opus 4.8",
    tagline: "The most capable builder — best for a game from scratch.",
  },
  {
    id: "claude-sonnet-5",
    name: "Sonnet 5",
    tagline: "Most of the ability, a good deal faster. Good for iterating.",
  },
  {
    id: "claude-haiku-4-5",
    name: "Haiku 4.5",
    tagline: "The quickest and cheapest — best for small, specific tweaks.",
  },
  {
    id: "nova-lite",
    name: "Nova Lite",
    tagline: "Amazon's affordable workhorse — plenty for plain-language tweaks.",
  },
  {
    id: "nova-micro",
    name: "Nova Micro",
    tagline: "The cheapest option here — for the smallest, quickest changes.",
  },
] as const

/**
 * The id of a model this app offers.
 *
 * Derived from the catalog rather than written out again, so the union and the
 * list a player sees cannot drift: adding an entry above is the whole of adding
 * a model, and every exhaustive switch on this type reports what is missing.
 */
export type GameModelId = (typeof GAME_MODELS)[number]["id"]

/**
 * What a turn runs on when nothing picked otherwise.
 *
 * Every turn today, since nothing sends a choice yet — so this is the model the
 * app actually uses, not a fallback that rarely fires.
 */
export const DEFAULT_GAME_MODEL_ID: GameModelId = "claude-opus-4-8"

/**
 * Whether a value names a model this app offers.
 *
 * A guard rather than a bare comparison, because the places that need it take
 * the id from somewhere the app doesn't control — a URL, a server action's
 * arguments — and want the narrowed type on the other side of the check.
 */
export function isGameModelId(value: unknown): value is GameModelId {
  return GAME_MODELS.some((model) => model.id === value)
}
