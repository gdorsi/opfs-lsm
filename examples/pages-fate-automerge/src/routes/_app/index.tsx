import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/")({ ssr: false, component: () => <main className="page" /> });
