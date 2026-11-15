import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

/**
 * No preloading: a loader here opens or closes the board on screen (session.ts), so running one on hover would
 * close the board the user is looking at. TanStack's default is off; this states it.
 */
export function getRouter() {
  return createRouter({ routeTree, scrollRestoration: false, defaultPreload: false });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
  /** A one-line notice the board list shows once, e.g. after the open board was deleted in another tab. */
  interface HistoryState {
    notice?: string;
  }
}
