/**
 * Registers the ServiceWorker that stores the built app's files, so the app opens with the server unreachable.
 * Only a build has one: the dev server's modules change without changing name, so they cannot be stored by name.
 */
export function keepAppOnDevice(): void {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js").catch((err: unknown) => console.warn("linearlite: the app is not stored for offline use", err));
}
