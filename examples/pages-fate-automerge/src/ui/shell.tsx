import { Outlet } from "@tanstack/react-router";
import { Loading } from "./boundary.tsx";
import { Sidebar } from "./sidebar.tsx";

export function Shell() {
  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        <Loading fallback={<div className="loading">Loading…</div>}>
          <Outlet />
        </Loading>
      </main>
    </div>
  );
}
