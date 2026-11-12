// Run in a warm page showing /issues, offline. `bench/client.ts frames` runs it on a copy of the profile, since the
// edits stay pending. Twelve status edits, one a second; for each, the longest gap between animation frames in the
// second after it. A recount of the issues after a change is the main work an edit leaves on the main thread.
(async () => {
  const { store, commands } = globalThis.__linearlite;
  const { docs } = await store.docs.collection("issues").query({ index: "search", eq: [false], reverse: true, limit: 400 });
  const gaps = async (ms) => {
    const out = [];
    let last = performance.now();
    const end = last + ms;
    while (performance.now() < end) {
      await new Promise((r) => requestAnimationFrame(r));
      const now = performance.now();
      out.push(now - last);
      last = now;
    }
    return out;
  };
  const idle = Math.max(...(await gaps(1000)));
  const edits = [];
  for (const d of docs.slice(220, 232)) {
    const written = commands.setStatus(d.id, (d.status + 1) % 5);
    const after = await gaps(1000);
    await written;
    edits.push(Math.max(...after));
  }
  return JSON.stringify({ idle, edits });
})()
