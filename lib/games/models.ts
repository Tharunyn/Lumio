import { bedrock } from "@ai-sdk/amazon-bedrock"
import { bedrockAnthropic } from "@ai-sdk/amazon-bedrock/anthropic"
import type { LanguageModel } from "ai"

import type { GameModelId } from "./model-catalog"

/**
 * The provider instance behind each catalog entry.
 *
 * Server-side only — constructing these reaches for the Bedrock credentials
 * (`AWS_REGION`, and `AWS_BEARER_TOKEN_BEDROCK` or AWS access keys), and the
 * provider SDK has no business in a browser bundle. There is no `server-only`
 * marker enforcing that, though, for the same reason `@/lib/db` keeps its
 * marker in a separate entry: the chat agent imports this module and runs in
 * the Trigger.dev worker, where that marker throws. Reach for the catalog
 * instead of this file from anything a client component can touch.
 *
 * The ids are Bedrock's own: the `us.` prefix is a US geo inference profile,
 * which is how the newest Opus and Sonnet models are reached on Bedrock
 * (in-region endpoint absent). Claude models go through `bedrockAnthropic`,
 * the native Anthropic route over Bedrock's InvokeModel endpoint, so the call
 * is the same shape the app used with the direct Anthropic API; Nova models go
 * through `bedrock`, the Converse route.
 *
 * `satisfies` rather than an annotation, so the record has to cover every
 * `GameModelId` — a model added to the catalog and forgotten here is a type
 * error, not an undefined model discovered at the top of someone's turn.
 */
export const gameModels = {
  "claude-opus-4-8": bedrockAnthropic("us.anthropic.claude-opus-4-8"),
  "claude-sonnet-5": bedrockAnthropic("us.anthropic.claude-sonnet-5"),
  "claude-haiku-4-5": bedrockAnthropic("us.anthropic.claude-haiku-4-5-20251001-v1:0"),
  "nova-lite": bedrock("us.amazon.nova-lite-v1:0"),
  "nova-micro": bedrock("us.amazon.nova-micro-v1:0"),
} satisfies Record<GameModelId, LanguageModel>
