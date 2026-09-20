import { S3Client } from "@aws-sdk/client-s3"

if (!process.env.GAME_BUNDLE_BUCKET) {
  throw new Error("GAME_BUNDLE_BUCKET is not set")
}

// The object-key namespace every game's bundle lives under:
// `games/{gameId}/...`. Shared with the CloudFront signer, which builds the
// same urls the objects are stored at — hence exported from here rather than
// restated in each caller.
export const GAME_BUNDLE_PREFIX = "games"

export const GAME_BUNDLE_BUCKET = process.env.GAME_BUNDLE_BUCKET

// Region and credentials come from the environment like the rest of the AWS
// stack (Bedrock already needs them): the SDK's default chain resolves
// `AWS_REGION` and whichever credentials this deployment provides.
export const s3 = new S3Client()