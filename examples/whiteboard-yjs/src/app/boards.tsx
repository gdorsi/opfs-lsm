/**
 * The board list: create, rename, delete, open, and the two sample boards for the size checks.
 * Reads `ws.boards()` and `ws.save()`; writes through the workspace's own methods.
 */
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { scatterShape, type BoardMeta, type Workspace } from "../model/index.ts";
import { WorkspaceSaveBadge } from "./board-screen.tsx";
import { useSession, useWorkspace } from "./hooks.ts";
import { showBoard } from "./session.ts";

export function BoardsScreen(): ReactNode {
  const { ws, storage } = useSession();
  const { boards } = useWorkspace(ws);
  const navigate = useNavigate();
  const notice = useRouterState({ select: (s) => s.location.state.notice });
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const fail = (e: unknown) => setError(e instanceof Error ? e : new Error(String(e)));
  const create = () => {
    const id = ws.createBoard("Untitled board");
    void navigate({ to: "/b/$id", params: { id } });
  };
  const sample = (count: number) => {
    setBusy(count);
    fillSample(ws, count).then(
      (id) => navigate({ to: "/b/$id", params: { id } }),
      (e: unknown) => {
        setBusy(null);
        fail(e);
      },
    );
  };

  return (
    <main className="boards">
      <header className="boards-header">
        <h1>Boards</h1>
        <span className="chip">{storage === "kv" ? "OPFS (kv)" : "IndexedDB"}</span>
        <WorkspaceSaveBadge ws={ws} />
      </header>
      {notice && <p className="notice">{notice}</p>}
      {error && (
        <p className="notice error" role="alert">
          {error.message}
        </p>
      )}
      <div className="boards-actions">
        <button className="btn primary" onClick={create}>
          New board
        </button>
        {import.meta.env.DEV &&
          SAMPLE_SIZES.map((n) => (
            <button key={n} className="btn" disabled={busy !== null} onClick={() => sample(n)}>
              {busy === n ? "Filling…" : `Sample ${n.toLocaleString()}`}
            </button>
          ))}
      </div>
      {boards.length === 0 ? (
        <p className="empty">No boards yet.</p>
      ) : (
        <ul className="board-list">
          {boards.map((meta) => (
            <li key={meta.id}>
              <Link to="/b/$id" params={{ id: meta.id }} className="board-link">
                {meta.title}
              </Link>
              <time>{new Date(meta.createdAt).toLocaleDateString()}</time>
              <Rename ws={ws} meta={meta} />
              {confirming === meta.id ? (
                <button
                  className="btn danger small"
                  onClick={() => {
                    setConfirming(null);
                    ws.deleteBoard(meta.id).catch(fail);
                  }}
                  onBlur={() => setConfirming(null)}
                  autoFocus
                >
                  Confirm delete
                </button>
              ) : (
                <button className="btn small" onClick={() => setConfirming(meta.id)}>
                  Delete
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

/** Inline rename: commits on Enter or blur, never per keystroke (each rename is a Yjs transaction). Blank reverts. */
function Rename({ ws, meta }: { ws: Workspace; meta: BoardMeta }): ReactNode {
  const [draft, setDraft] = useState<string | null>(null);
  if (draft === null) {
    return (
      <button className="btn small" onClick={() => setDraft(meta.title)}>
        Rename
      </button>
    );
  }
  const commit = () => {
    const title = draft.trim();
    if (title !== "") ws.renameBoard(meta.id, title);
    setDraft(null);
  };
  return (
    <input
      className="rename"
      value={draft}
      autoFocus
      aria-label={`Rename ${meta.title}`}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setDraft(null);
      }}
    />
  );
}

const SAMPLE_SIZES = [5_000, 20_000];

const yieldTask = () => new Promise<void>((resolve) => setTimeout(resolve));

/**
 * Creates a board and fills it with `count` sample shapes, 1,000 per `create` command, yielding a task between
 * commands so the page keeps painting. Opens it through the slot, so the board route finds it open.
 * The one board writer outside the controller (core/input.ts): dev seeding, before any controller exists. User
 * actions never dispatch from here.
 */
async function fillSample(ws: Workspace, count: number): Promise<string> {
  const id = ws.createBoard(`Sample ${count.toLocaleString()}`);
  const board = await showBoard(id);
  const shapes = Array.from({ length: count }, () => scatterShape(Math.random));
  for (let i = 0; i < shapes.length; i += 1000) {
    board.dispatch({ type: "create", shapes: shapes.slice(i, i + 1000) });
    await yieldTask();
  }
  return id;
}
