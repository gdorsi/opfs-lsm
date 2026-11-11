import { createFileRoute, redirect } from "@tanstack/react-router";

/** The old proof page's address. Keeps the query string (`?user=`, `?db=`, `?pull=`) for the store, which reads it. */
export const Route = createFileRoute("/issues")({
  ssr: false,
  beforeLoad: () => {
    throw redirect({ href: `/${location.search}` });
  },
});
