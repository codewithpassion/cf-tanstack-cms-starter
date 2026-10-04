import { clerkMiddleware } from "@clerk/tanstack-react-start/server";
import {
  createCsrfMiddleware,
  createMiddleware,
  createStart,
} from "@tanstack/react-start";
import { skipsClerk } from "#/lib/clerk-skip";

const csrfMiddleware = createCsrfMiddleware({
  filter: (context) => context.handlerType === "serverFn",
});

// Clerk on every request except the public ones in `skipsClerk`.
const clerk = clerkMiddleware();
// biome-ignore lint/style/noNonNullAssertion: clerkMiddleware always defines a server handler.
const runClerk = clerk.options.server!;
const clerkExceptPublic = createMiddleware().server((ctx) =>
  skipsClerk(new URL(ctx.request.url).pathname) ? ctx.next() : runClerk(ctx)
);

export const startInstance = createStart(() => ({
  requestMiddleware: [csrfMiddleware, clerkExceptPublic],
}));
