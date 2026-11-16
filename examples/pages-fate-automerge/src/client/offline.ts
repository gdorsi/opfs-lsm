export function keepAppOnDevice(): void {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js").catch((err: unknown) => console.warn("pages: the app is not stored for offline use", err));
}
