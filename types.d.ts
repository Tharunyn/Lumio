import type { ReactNode } from "react"

/* eslint-disable @typescript-eslint/no-unused-vars -- the route string is
   documentation only; see the note below. */

/**
 * Route generics once declared by `@clerk/nextjs`, which is no longer
 * installed: `PageProps<"/games/[id]">` in a page, `LayoutProps<"/">` in a
 * layout and `RouteContext<"/…">` in a route handler. The route string is
 * documentation only — the props that resolve it are typed from `params` and
 * `searchParams` as Next.js serves them (Promises, per App Router RSC).
 */
declare global {
  type PageProps<_Route extends string = string> = {
    params: Promise<Record<string, string>>
    searchParams: Promise<Record<string, string | string[] | undefined>>
  }

  type LayoutProps<_Route extends string = string> = {
    params: Promise<Record<string, string>>
    children: ReactNode
  }

  type RouteContext<_Route extends string = string> = {
    params: Promise<Record<string, string>>
  }
}