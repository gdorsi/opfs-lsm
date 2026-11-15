import { HeadContent, Link, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import appCss from "../app/app.css?url";
import { MessagePage, Tooltips } from "../app/ui.tsx";

const FAVICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="6.5" fill="#1c1b18"/><rect x="5.5" y="6" width="8" height="7" rx="1.5" fill="none" stroke="#fff" stroke-width="1.7"/><circle cx="15.5" cy="15.5" r="3.6" fill="#3451d1" stroke="#fff" stroke-width="1.7"/></svg>',
  );

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { name: "theme-color", content: "#f5f4f0" },
      { title: "Whiteboard" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: FAVICON },
    ],
  }),
  component: () => (
    <Shell>
      <Outlet />
    </Shell>
  ),
  notFoundComponent: () => (
    <MessagePage
      title="Nothing here"
      action={
        <Link to="/" className="btn primary">
          Back to boards
        </Link>
      }
    >
      <p>This address doesn’t match a page or a board. Check the link, or start from your boards.</p>
    </MessagePage>
  ),
});

function Shell({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Tooltips />
        <Scripts />
      </body>
    </html>
  );
}
