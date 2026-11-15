import { createFileRoute } from "@tanstack/react-router";
import { DetailScreen } from "../../ui/detail.tsx";

export const Route = createFileRoute("/_app/issue/$id")({
  ssr: false,
  component: () => <DetailScreen id={Route.useParams().id} />,
});
