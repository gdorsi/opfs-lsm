import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { scatterShape, type BoardMeta, type Workspace } from "../model/index.ts";
import { useSession, useWorkspace } from "./hooks.ts";
import { Icon, ICON, Mark } from "./icons.tsx";
import { showBoard } from "./session.ts";
import { IconButton, TitleInput, WorkspaceSaveBadge } from "./ui.tsx";

export function BoardsScreen(): ReactNode {
  const { ws } = useSession();
  const { boards } = useWorkspace(ws);
  const newestFirst = useMemo(() => [...boards].reverse(), [boards]);
  const navigate = useNavigate();
  const notice = useRouterState({ select: (s) => s.location.state.notice });
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const now = useNow(30_000);

  const fail = (e: unknown) => setError(e instanceof Error ? e : new Error(String(e)));
  const create = () => {
    const id = ws.createBoard("Untitled board");
    void navigate({ to: "/b/$id", params: { id } });
  };

  return (
    <div className="home">
      <header className="topbar">
        <span className="brand">
          <Mark />
          Whiteboard
        </span>
        <div className="topbar-status">
          <WorkspaceSaveBadge ws={ws} />
        </div>
      </header>
      <main className="home-main">
        {notice && notice !== dismissed && (
          <Banner icon={ICON.info} onDismiss={() => setDismissed(notice)}>
            {notice}
          </Banner>
        )}
        {error && (
          <Banner icon={ICON.alert} tone="error" onDismiss={() => setError(null)}>
            {error.message}
          </Banner>
        )}
        {boards.length === 0 ? (
          <EmptyBoards onCreate={create} />
        ) : (
          <>
            <div className="home-head">
              <h1>
                Boards <span className="count">{boards.length}</span>
              </h1>
              <button type="button" className="btn primary" onClick={create}>
                <Icon size={18}>{ICON.plus}</Icon>
                New board
              </button>
            </div>
            <ul className="board-grid">
              {newestFirst.map((meta) => (
                <BoardCard key={meta.id} ws={ws} meta={meta} now={now} onError={fail} />
              ))}
            </ul>
          </>
        )}
      </main>
      {import.meta.env.DEV && <DevTools ws={ws} onError={fail} />}
    </div>
  );
}

function Banner({ icon, tone, onDismiss, children }: { icon: ReactNode; tone?: "error"; onDismiss: () => void; children: ReactNode }) {
  return (
    <div className="banner" data-tone={tone} role={tone === "error" ? "alert" : "status"}>
      <Icon size={18}>{icon}</Icon>
      <p>{children}</p>
      <IconButton label="Dismiss" icon={ICON.close} className="small" onClick={onDismiss} />
    </div>
  );
}

function EmptyBoards({ onCreate }: { onCreate: () => void }): ReactNode {
  return (
    <section className="empty-boards">
      <svg className="empty-art" viewBox="0 0 240 140" aria-hidden="true">
        <rect className="a" x="22" y="34" width="78" height="58" rx="8" pathLength="1" />
        <path className="b" d="M106 63h36m0 0l-9-7m9 7l-9 7" pathLength="1" />
        <ellipse className="c" cx="182" cy="63" rx="36" ry="29" pathLength="1" />
        <path className="d" d="M40 118c22-10 42 6 64-2s40-10 62 0 34 4 48-4" pathLength="1" />
      </svg>
      <h1>Start your first board</h1>
      <p>Sketch with shapes, arrows, text and a pen. Boards are kept in this browser.</p>
      <button type="button" className="btn primary large" onClick={onCreate}>
        <Icon size={18}>{ICON.plus}</Icon>
        New board
      </button>
    </section>
  );
}

function BoardCard({ ws, meta, now, onError }: { ws: Workspace; meta: BoardMeta; now: number; onError: (e: unknown) => void }) {
  const [renaming, setRenaming] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const created = new Date(meta.createdAt);
  return (
    <li className="card" data-busy={renaming || confirming || undefined}>
      <Cover id={meta.id} title={meta.title} />
      <div className="card-body">
        <div className="card-text">
          {renaming ? (
            <TitleInput ws={ws} meta={meta} className="card-rename" onDone={() => setRenaming(false)} />
          ) : (
            <Link to="/b/$id" params={{ id: meta.id }} className="card-title">
              {meta.title}
            </Link>
          )}
          <time dateTime={created.toISOString()} title={FULL_DATE.format(created)}>
            Created {sinceText(meta.createdAt, now)}
          </time>
        </div>
      </div>
      <div className="card-actions">
        <IconButton label={`Rename ${meta.title}`} tip="Rename" icon={ICON.rename} className="small" onClick={() => setRenaming(true)} />
        <IconButton label={`Delete ${meta.title}`} tip="Delete" icon={ICON.trash} className="small danger" onClick={() => setConfirming(true)} />
      </div>
      {confirming && (
        <div
          className="card-confirm"
          role="group"
          aria-label={`Delete ${meta.title}`}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget)) setConfirming(false);
          }}
          onKeyDown={(e) => e.key === "Escape" && setConfirming(false)}
        >
          <p>
            <strong>Delete “{meta.title}”?</strong>
            <span>You can’t undo this.</span>
          </p>
          <div className="card-confirm-actions">
            <button type="button" className="btn" autoFocus onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button type="button" className="btn danger" onClick={() => ws.deleteBoard(meta.id).catch(onError)}>
              Delete
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

const HUES = [
  ["#e03131", "#ffc9c9"],
  ["#2f9e44", "#b2f2bb"],
  ["#1971c2", "#a5d8ff"],
  ["#f08c00", "#ffec99"],
  ["#9c36b5", "#eebefa"],
] as const;
function hueOf(id: string): (typeof HUES)[number] {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return HUES[(h >>> 0) % HUES.length]!;
}

function Cover({ id, title }: { id: string; title: string }): ReactNode {
  const dots = useId();
  const [stroke, fill] = hueOf(id);
  return (
    <svg className="cover" viewBox="0 0 240 150" preserveAspectRatio="xMidYMid slice" aria-hidden="true" style={{ color: stroke }}>
      <defs>
        <pattern id={dots} width="12" height="12" patternUnits="userSpaceOnUse">
          <circle cx="6" cy="6" r="1" fill="currentColor" stroke="none" opacity="0.28" />
        </pattern>
      </defs>
      <rect width="240" height="150" fill={fill} opacity="0.3" stroke="none" />
      <rect width="240" height="150" fill={`url(#${dots})`} stroke="none" />
      <text x="120" y="75" className="cover-initial">
        {[...title.trim()][0]?.toUpperCase()}
      </text>
    </svg>
  );
}

const RELATIVE = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const SHORT_DATE = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });
const LONG_DATE = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" });
const FULL_DATE = new Intl.DateTimeFormat("en", { dateStyle: "long", timeStyle: "short" });
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function sinceText(at: number, now: number): string {
  const ago = now - at;
  if (ago < MINUTE) return "just now";
  if (ago < HOUR) return RELATIVE.format(-Math.round(ago / MINUTE), "minute");
  if (ago < DAY) return RELATIVE.format(-Math.round(ago / HOUR), "hour");
  if (ago < 7 * DAY) return RELATIVE.format(-Math.round(ago / DAY), "day");
  const date = new Date(at);
  return new Date(now).getFullYear() === date.getFullYear() ? SHORT_DATE.format(date) : LONG_DATE.format(date);
}

function useNow(everyMs: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

const SAMPLE_SIZES = [5_000, 20_000];

function DevTools({ ws, onError }: { ws: Workspace; onError: (e: unknown) => void }): ReactNode {
  const navigate = useNavigate();
  const [busy, setBusy] = useState<number | null>(null);
  const sample = (count: number) => {
    setBusy(count);
    fillSample(ws, count).then(
      (id) => navigate({ to: "/b/$id", params: { id } }),
      (e: unknown) => {
        setBusy(null);
        onError(e);
      },
    );
  };
  return (
    <footer className="dev-tools">
      <span className="dev-label">
        <Icon size={16}>{ICON.code}</Icon>
        Dev build
      </span>
      <span className="dev-samples">
        Sample board:
        {SAMPLE_SIZES.map((n) => (
          <button key={n} type="button" className="link-btn" disabled={busy !== null} onClick={() => sample(n)}>
            {busy === n ? "Filling…" : `${n.toLocaleString("en")} shapes`}
          </button>
        ))}
      </span>
    </footer>
  );
}

const yieldTask = () => new Promise<void>((resolve) => setTimeout(resolve));

async function fillSample(ws: Workspace, count: number): Promise<string> {
  const id = ws.createBoard(`Sample ${count.toLocaleString("en")}`);
  const board = await showBoard(id);
  const shapes = Array.from({ length: count }, () => scatterShape(Math.random));
  for (let i = 0; i < shapes.length; i += 1000) {
    board.dispatch({ type: "create", shapes: shapes.slice(i, i + 1000) });
    await yieldTask();
  }
  return id;
}
