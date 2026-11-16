export function keepAppOnDevice(): void {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js").catch((err: unknown) => console.warn("notes: the app is not stored for offline use", err));
}
