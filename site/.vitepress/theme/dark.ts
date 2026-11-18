import { useData } from "vitepress";
import { computed } from "vue";

/** Whether the page is dark: the landing page always is, and every other page follows the reader's appearance. */
export function usePageDark() {
  const { frontmatter, isDark } = useData();
  return computed(() => frontmatter.value.layout === "home" || isDark.value);
}
