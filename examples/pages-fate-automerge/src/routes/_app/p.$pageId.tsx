import { createFileRoute } from "@tanstack/react-router";
import { parsePageId } from "../../model/bodies.ts";
import { NotFound, PageScreen } from "../../ui/page.tsx";

export const Route = createFileRoute("/_app/p/$pageId")({
  ssr: false,
  component: function PageRoute() {
    const id = parsePageId(Route.useParams().pageId);
    return id ? <PageScreen key={id} id={id} /> : <NotFound />;
  },
});
