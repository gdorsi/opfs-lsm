import { Link, createFileRoute } from "@tanstack/react-router";
import { BoardLoadError, boardId } from "../../model/index.ts";
import { BoardScreen } from "../../app/board-screen.tsx";
import { showBoard } from "../../app/session.ts";

/**
 * One board. The loader opens it through the slot (session.ts); the list's loader closes it. `gcTime: 0`: a board
 * that left the screen is closed, so its loader data must never be shown again; re-entering runs the loader.
 * Lifecycle is not in onLeave (TanStack calls onStay for /b/1 -> /b/2, same route id) and not in an effect
 * (StrictMode runs effect cleanups twice in dev).
 */
export const Route = createFileRoute("/_app/b/$id")({
  ssr: false,
  gcTime: 0,
  loader: ({ params }) => showBoard(boardId(params.id)),
  pendingMs: 200,
  pendingComponent: () => <div className="splash">Opening board…</div>,
  errorComponent: ({ error }) => (
    <div className="splash" role="alert">
      <p>{error instanceof BoardLoadError ? "This board does not exist here, or could not be read." : String(error)}</p>
      <Link to="/">Back to boards</Link>
    </div>
  ),
  component: () => {
    const board = Route.useLoaderData();
    return <BoardScreen key={board.id} board={board} />;
  },
});
