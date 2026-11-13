import type { LookTokens } from "./kit";
import "./look.css";

export type SceneTheme = "light" | "dark";

/**
 * The site's look, shared by every illustration. The ground is the page's own soft gray, so a stage reads as part
 * of the page. On the dark page the cards step up from it, because the kit's dark surfaces are darker than
 * VitePress's page. The type is the system's: its figures line up in columns, which the page's Inter subset
 * does not do.
 */
export const tokens = (theme: SceneTheme): LookTokens => ({
  "--ss-mono": "var(--vp-font-family-mono, ui-monospace, Menlo, monospace)",
  "--ss-well": theme === "dark" ? "var(--vp-c-bg-soft, #202127)" : "var(--vp-c-bg-soft, #f6f6f7)",
  ...(theme === "dark" ? { "--ss-surface": "#2b2c33", "--ss-raised": "#35363e" } : {}),
});

export const ACCENT = "var(--vp-c-brand-3, #5672cd)";
