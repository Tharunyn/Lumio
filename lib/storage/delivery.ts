import { getSignedUrl } from "@aws-sdk/cloudfront-signer"

import { GAME_BUNDLE_PREFIX } from "@/lib/storage/client"

// How long a signed preview url stays valid. An hour, matching what the
// preview urls it replaces were signed for.
const PREVIEW_URL_TTL_SECONDS = 3600

if (!process.env.CLOUDFRONT_DOMAIN) {
  throw new Error("CLOUDFRONT_DOMAIN is not set")
}

if (!process.env.CLOUDFRONT_KEY_PAIR_ID) {
  throw new Error("CLOUDFRONT_KEY_PAIR_ID is not set")
}

if (!process.env.CLOUDFRONT_PRIVATE_KEY) {
  throw new Error("CLOUDFRONT_PRIVATE_KEY is not set")
}

const CLOUDFRONT_DOMAIN = process.env.CLOUDFRONT_DOMAIN
const CLOUDFRONT_KEY_PAIR_ID = process.env.CLOUDFRONT_KEY_PAIR_ID

// The private key crosses an env var boundary, where newlines are unreliable:
// a deployment stores them as real line breaks or as literal `\n` sequences.
// Either is accepted, so the key works no matter which way it was set.
const CLOUDFRONT_PRIVATE_KEY = process.env.CLOUDFRONT_PRIVATE_KEY.replace(
  /\\n/g,
  "\n"
)

/**
 * The signed url the preview loads a game from.
 *
 * The distribution fronts the game bundle bucket, so signing the entry point's
 * url — `/{gameId}/index.html` — is what grants access to the game. The policy
 * that authorizes it is a custom policy whose Resource is the game's whole
 * prefix, `/{gameId}/*`: CloudFront matches each *request's* url against that
 * Resource, so the page and every file it pulls in relative form (./style.css,
 * ./engine/*.js) are authorized by the same signature, with no per-file urls
 * to sign or hand out.
 *
 * The signature expires on its own (`PREVIEW_URL_TTL_SECONDS`), so the app
 * never has to remember or revoke urls it handed out — an old tab running a
 * finished preview simply stops being authorized.
 */
export function previewUrlFor(gameId: string): string {
  const expiresAt = new Date(Date.now() + PREVIEW_URL_TTL_SECONDS * 1000)

  return getSignedUrl({
    // The url the browser gets: the entry point the player loads. It names a
    // concrete file, but the policy below is what CloudFront checks against,
    // and the two are free to differ — hence passing both.
    url: `https://${CLOUDFRONT_DOMAIN}/${GAME_BUNDLE_PREFIX}/${gameId}/index.html`,
    keyPairId: CLOUDFRONT_KEY_PAIR_ID,
    privateKey: CLOUDFRONT_PRIVATE_KEY,
    policy: customPolicyFor(gameId, expiresAt),
  })
}

/**
 * The custom policy one game's signed url carries.
 *
 * The Resource is the game's prefix with a trailing wildcard — `/{gameId}/*`.
 * A trailing `*` in the path section of a policy Resource also implies a `*`
 * in the query section, so a request for `index.html` and one for a
 * sub-resource beneath the same game both match it. The returned url stays the
 * concrete entry point; the wildcard is what the policy grants, not what the
 * browser navigates to.
 *
 * Built with `JSON.stringify` so the signed policy is byte-for-byte the policy
 * CloudFront decodes from the url's `Policy` parameter: the signature covers
 * this exact string, and any whitespace CloudFront didn't see when verifying
 * would break it.
 */
function customPolicyFor(gameId: string, expiresAt: Date): string {
  return JSON.stringify({
    Statement: [
      {
        Resource: `https://${CLOUDFRONT_DOMAIN}/${GAME_BUNDLE_PREFIX}/${gameId}/*`,
        Condition: {
          DateLessThan: {
            "AWS:EpochTime": Math.round(expiresAt.getTime() / 1000),
          },
        },
      },
    ],
  })
}