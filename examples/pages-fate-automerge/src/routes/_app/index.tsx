import { createFileRoute } from "@tanstack/react-router";
import { EmptyState } from "../../ui/page.tsx";

export const Route = createFileRoute("/_app/")({ ssr: false, component: EmptyState });
