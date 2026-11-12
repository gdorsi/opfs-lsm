const sameYear = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });
const otherYear = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" });
const full = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

export const shortId = (id: string) => `LL-${id.slice(0, 5).toUpperCase()}`;

export function formatDate(ms: number): string {
  const d = new Date(ms);
  return (d.getFullYear() === new Date().getFullYear() ? sameYear : otherYear).format(d);
}

export const formatDateTime = (ms: number) => full.format(new Date(ms));
export const initial = (username: string) => username.slice(0, 1) || "?";
