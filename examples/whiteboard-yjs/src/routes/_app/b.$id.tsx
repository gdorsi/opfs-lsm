import { Link, createFileRoute } from "@tanstack/react-router";
import { BoardLoadError, boardId } from "../../model/index.ts";
import { BoardScreen } from "../../app/board-screen.tsx";
import { showBoard } from "../../app/session.ts";
import { MessagePage, Splash } from "../../app/ui.tsx";

/**
 * `gcTime: 0`: a board that left the screen is closed, so its loader data must never be shown again; re-entering
 * runs the loader.
 */
export const Route = createFileRoute("/_app/b/$id")({
  ssr: false,
  gcTime: 0,
  loader: ({ params }) => showBoard(boardId(params.id)),
  pendingMs: 200,
  pendingComponent: () => <Splash>Opening board…</Splash>,
  errorComponent: ({ error }) => (
    <MessagePage
      title="Can’t open this board"
      alert
      action={
        <Link to="/" className="btn primary">
          Back to boards
        </Link>
      }
    >
      {error instanceof BoardLoadError ? (
        <p>It may have been deleted, or storage couldn’t read it. Boards stay in the browser that made them, so a link from another browser won’t open here.</p>
      ) : (
        <p className="message-detail">{String(error)}</p>
      )}
    </MessagePage>
  ),
  component: () => {
    const board = Route.useLoaderData();
    return <BoardScreen key={board.id} board={board} />;
  },
});
