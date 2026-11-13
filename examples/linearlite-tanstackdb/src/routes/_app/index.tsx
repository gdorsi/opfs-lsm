import { createFileRoute } from "@tanstack/react-router";
import { ListScreen } from "../../ui/list.tsx";

export const Route = createFileRoute("/_app/")({ ssr: false, component: ListScreen });
