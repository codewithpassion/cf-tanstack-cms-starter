// The tRPC client for route loaders and components. In the browser it calls
// /api/trpc over HTTP. During SSR it calls the router in-process: a Worker
// fetching its own URL is a needless round trip, and relative URLs do not
// resolve on the server.
//
// superjson is the transformer on initTRPC (server/trpc/init.ts) and on both
// links below, so a Date, Map or Set arrives as itself whether the call ran
// in-process during SSR or over HTTP in the browser. Add it to any new link too.
import { createIsomorphicFn } from "@tanstack/react-start";
import {
  createTRPCClient,
  httpBatchLink,
  unstable_localLink,
} from "@trpc/client";
import superjson from "superjson";
import { createSsrContext } from "#/server/trpc/context";
import { type AppRouter, appRouter } from "#/server/trpc/router";

export const getTrpc = createIsomorphicFn()
  .server(() =>
    createTRPCClient<AppRouter>({
      links: [
        unstable_localLink({
          createContext: createSsrContext,
          router: appRouter,
          transformer: superjson,
        }),
      ],
    })
  )
  .client(() =>
    createTRPCClient<AppRouter>({
      links: [httpBatchLink({ transformer: superjson, url: "/api/trpc" })],
    })
  );
