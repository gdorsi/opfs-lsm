import { createFileRoute } from "@tanstack/react-router";
import { BoardsScreen } from "../../app/boards.tsx";
import { hideBoard } from "../../app/session.ts";

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
