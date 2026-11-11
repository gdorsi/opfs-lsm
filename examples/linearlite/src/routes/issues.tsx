import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/issues")({
  ssr: false,
  beforeLoad: () => {
    throw redirect({ href: `/${location.search}` });
  },
});
