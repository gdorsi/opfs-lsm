import { createFileRoute } from "@tanstack/react-router";
import { BoardScreen } from "../../ui/board.tsx";

export const Route = createFileRoute("/_app/board")({ ssr: false, component: BoardScreen });
