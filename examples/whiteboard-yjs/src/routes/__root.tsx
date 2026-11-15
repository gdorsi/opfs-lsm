import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import appCss from "../app/app.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [{ charSet: "utf-8" }, { name: "viewport", content: "width=device-width, initial-scale=1" }, { title: "Whiteboard" }],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  component: () => (
    <Shell>
      <Outlet />
    </Shell>
  ),
});

/** The only part rendered on the server. Every app route below sets ssr: false. */
function Shell({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
