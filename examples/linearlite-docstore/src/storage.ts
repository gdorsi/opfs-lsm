import { CHECK } from "./icons.ts";
import { failed } from "./protocol.ts";
import { freeSpace, watchPressure, type Store } from "./store.ts";

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
