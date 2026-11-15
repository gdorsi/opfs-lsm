import { createFileRoute } from "@tanstack/react-router";
import { BoardsScreen } from "../../app/boards.tsx";
import { hideBoard } from "../../app/session.ts";
import { MessagePage, Splash } from "../../app/ui.tsx";

export const Route = createFileRoute("/_app/")({
  ssr: false,
  loader: () => hideBoard(),
  pendingMs: 200,
  pendingComponent: () => <Splash>Saving…</Splash>,
  errorComponent: ({ error, reset }) => (
    <MessagePage
      title="The last changes may not be saved"
      alert
      action={
        <button type="button" className="btn primary" onClick={reset}>
          Back to boards
        </button>
      }
    >
      <p className="message-detail">{String(error)}</p>
    </MessagePage>
  ),
  component: BoardsScreen,
});
