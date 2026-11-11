import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import appCss from "../ui/app.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [{ charSet: "utf-8" }, { name: "viewport", content: "width=device-width, initial-scale=1" }, { title: "LinearLite" }],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  component: () => (
    <Shell>
      <Outlet />
    </Shell>
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
        <Scripts />
      </body>
    </html>
  );
}
