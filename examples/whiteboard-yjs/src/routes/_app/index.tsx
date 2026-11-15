import { createFileRoute } from "@tanstack/react-router";
import { BoardsScreen } from "../../app/boards.tsx";
import { hideBoard } from "../../app/session.ts";

/**
 * The board list. Its loader closes the board that was on screen and waits for that close, so a storage error in the
 * board's last flush shows here instead of vanishing with the board.
 */
export const Route = createFileRoute("/_app/")({
  ssr: false,
  loader: () => hideBoard(),
  pendingMs: 200,
  pendingComponent: () => <div className="splash">Saving…</div>,
  errorComponent: ({ error, reset }) => (
    <div className="splash" role="alert">
      <p>The last changes to the board may not be saved: {String(error)}</p>
      <button className="btn" onClick={reset}>
        Back to boards
      </button>
    </div>
  ),
  component: BoardsScreen,
});
