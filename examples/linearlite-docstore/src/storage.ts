import { CHECK } from "./icons.ts";
import { failed } from "./protocol.ts";
import { freeSpace, storedBytes, watchPressure, type Store } from "./store.ts";

const MB = 1_000_000;
const CAP = "linearlite-demo:maxBytes";
/** Above what 100,000 issues take, so the alert waits until the viewer lowers the cap. */
const DEFAULT_CAP = 100 * MB;

/** The size cap the database opens with, in bytes: `?maxBytes=`, else the one set in the sidebar, else the default. */
export function capBytes(params: URLSearchParams): number {
  const fromUrl = Number(params.get("maxBytes"));
  if (fromUrl > 0) return fromUrl;
  let saved = 0;
  try {
    saved = Number(localStorage.getItem(CAP));
  } catch {}
  return saved > 0 ? saved : DEFAULT_CAP;
}

const mb = (bytes: number) => `${(bytes / MB).toFixed(bytes < 10 * MB ? 2 : 1)} MB`;

/**
 * The sidebar's storage panel: the bytes kv counts against the cap, and the cap, which the viewer can change. kv
 * takes the cap when the database opens, so a new one reloads the app.
 */
export function createUsage(panel: HTMLElement, store: Store, cap: number) {
  const used = panel.querySelector<HTMLElement>("#used")!;
  const fill = panel.querySelector<HTMLElement>(".bar > i")!;
  const input = panel.querySelector<HTMLInputElement>("#cap")!;
  input.value = String(cap / MB);
  input.onchange = () => {
    const next = Math.round(Number(input.value) * MB);
    if (!(next > 0) || next === cap) return void (input.value = String(cap / MB));
    // Kept for this browser. Without storage, the address carries it.
    const url = new URL(location.href);
    try {
      localStorage.setItem(CAP, String(next));
      url.searchParams.delete("maxBytes");
    } catch {
      url.searchParams.set("maxBytes", String(next));
    }
    location.replace(url);
  };
  // kv measures after each flush, in the SharedWorker, so the panel asks again every two seconds.
  const draw = async () => {
    if (document.hidden) return;
    const bytes = await storedBytes(store).catch(() => undefined);
    if (bytes === undefined) return;
    used.textContent = mb(bytes);
    fill.style.width = `${Math.min(100, (bytes / cap) * 100)}%`;
    panel.classList.toggle("over", bytes > cap);
  };
  void draw();
  setInterval(() => void draw(), 2000);
}

/**
 * The alert every tab shows while storage pressure waits for a yes. Nothing is removed before the click. The tab
 * that is clicked frees the space, and the alert goes from all of them.
 */
export function createStorageAlert(store: Store) {
  const backdrop = document.createElement("div");
  backdrop.className = "backdrop";
  backdrop.innerHTML = `
<div class="modal storage" role="alertdialog" aria-labelledby="storage-title" aria-describedby="storage-text">
  <header>
    <span class="storage-badge" aria-hidden="true">
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
        <ellipse cx="9" cy="4.5" rx="6" ry="2.5" stroke="currentColor" stroke-width="1.4" />
        <path d="M3 4.5v9c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5v-9M3 9c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5" stroke="currentColor" stroke-width="1.4" />
      </svg>
    </span>
    <div>
      <h2 id="storage-title">Storage is almost full</h2>
      <p>LinearLite needs to free space on this device.</p>
    </div>
  </header>
  <ul id="storage-text">
    <li>${CHECK} Cached descriptions and comments are removed</li>
    <li>${CHECK} They come back when you open an issue</li>
    <li>${CHECK} Issues and what you wrote stay</li>
  </ul>
  <button class="btn primary">Remove cached data</button>
</div>`;
  const button = backdrop.querySelector("button")!;
  // The button stays live after a click: a second confirmation is harmless, and the first may have failed.
  button.onclick = () => {
    button.textContent = "Removing…";
    freeSpace(store).catch(failed);
  };
  watchPressure(store, (pending) => {
    if (!pending) return backdrop.remove();
    if (backdrop.isConnected) return;
    button.textContent = "Remove cached data";
    document.body.append(backdrop);
    // In a frame, taking the focus would scroll the page around it to the frame.
    if (parent === window) button.focus();
  });
}
