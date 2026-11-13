import type { ComponentType } from "react";
import { createRoot } from "react-dom/client";
import Adapters from "./adapters/index.tsx";
import Bundle from "./bundle/index.tsx";
import type { SceneName } from "./sizes.ts";
import Stack from "./stack/index.tsx";
import Sync from "./sync/index.tsx";

const SCENES: Record<SceneName, ComponentType<never>> = { adapters: Adapters as ComponentType<never>, bundle: Bundle as ComponentType<never>, stack: Stack as ComponentType<never>, sync: Sync as ComponentType<never> };

/** Renders one illustration into `el`. A new `run` remounts it, which plays it again from the start. */
export function mount(el: HTMLElement, name: SceneName) {
  const root = createRoot(el);
  const Scene = SCENES[name] as ComponentType<Record<string, unknown>>;
  return {
    render: (props: Record<string, unknown>) => root.render(<Scene key={String(props.run)} {...props} />),
    unmount: () => root.unmount(),
  };
}
