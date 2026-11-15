// Run in a page showing /issues with default filters. `bench/client.ts` fills in the argument on the last line: the
// scenario (`jump`, `scroll` or `live`), the server's total and the jump targets. Rows are checked against the order
// the replica's `byModified` index holds, so a step passes only when every row shown has the sort value of the row
// at its position.
(async (truth) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  const paint = () =>
    new Promise((resolve) =>
      requestAnimationFrame(() => {
        const ch = new MessageChannel();
        ch.port1.onmessage = () => resolve(performance.now());
        ch.port2.postMessage(0);
      }),
    );
  const failures = [];
  const until = async (what, ready, timeout = 15_000) => {
    const end = performance.now() + timeout;
    for (;;) {
      if (ready()) return paint();
      if (performance.now() > end) {
        failures.push({ what, rows: rows().length, skeletons: document.querySelectorAll("[data-skeleton]").length });
        return NaN;
      }
      await frame();
    }
  };
  const rows = () => [...document.querySelectorAll(".row[data-id]")];
  const settled = () => rows().length > 0 && !document.querySelector("[data-skeleton]");
  const total = () => document.getElementById("count")?.textContent ?? "";
  const r1 = (x) => Math.round(x * 10) / 10;
  const stats = (v) => {
    const s = v.filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
    return s.length === 0 ? { n: 0 } : { n: s.length, failed: v.length - s.length, p50: r1(s[Math.floor((s.length - 1) / 2)]), min: r1(s[0]), max: r1(s.at(-1)) };
  };
  const scroller = () => document.getElementById("scroller");
  const store = globalThis.__linearlite.store;
  const issues = store.docs.collection("issues");
  const out = { mode: truth.mode };

  await until("start", () => settled() && total() === truth.total.toLocaleString("en-US"));

  /** The ids of the replica's first `to` live issues by modified, newest first. */
  const order = async (to) => (await issues.queryIds({ index: "byModified", eq: [false], reverse: true, limit: to })).ids;
  const modifiedOf = async (ids) => {
    const docs = await issues.getMany(ids);
    return new Map(ids.map((id, i) => [id, docs[i]?.modified]));
  };
  /** Rows in the DOM whose modified differs from the modified of the row `expectedId(index)` names. */
  const wrongRows = (expectedId, mods) =>
    rows().filter((r) => {
      const want = expectedId(Number(r.dataset.index));
      return want === undefined || mods.get(r.dataset.id) === undefined || mods.get(r.dataset.id) !== mods.get(want);
    }).length;

  if (truth.mode === "jump") {
    for (const { target, ids, runs } of truth.jumps) {
      const accepted = new Set(ids);
      const jumps = [];
      for (let i = 0; i < runs; i++) {
        const t0 = performance.now();
        scroller().scrollTop = target * 40;
        jumps.push((await until(`jump ${target}`, () => settled() && accepted.has(document.querySelector(`.row[data-index="${target}"]`)?.dataset.id))) - t0);
        if (i === 0) out[`held after first jump ${target}`] = store.issues.size;
        await sleep(150);
        scroller().scrollTop = 0;
        await until("top", () => settled() && !!document.querySelector('.row[data-index="0"]'));
        await sleep(150);
      }
      out[`jump ${target}`] = { ...stats(jumps), first: r1(jumps[0]) };
    }
    out.heldAtTop = store.issues.size;
    const heap = () => (globalThis.gc?.(), Math.round(performance.memory.usedJSHeapSize / 1e6));
    out.heapAtTop = heap();
    await sleep(6000);
    out.heldAtTopAfter6s = store.issues.size;
    out.heapAfter6s = heap();
    await sleep(6000);
    out.heapAfter12s = heap();
  }

  if (truth.mode === "scroll") {
    const ids = await order(54_000);
    const mods = await modifiedOf(ids.slice(46_000));
    const expected = (i) => ids[i];
    const step = async (what, dy) => {
      const t0 = performance.now();
      scroller().scrollTop += dy;
      await frame();
      const t = (await until(what, settled, 3000)) - t0;
      return { t, wrong: wrongRows(expected, mods) };
    };
    scroller().scrollTop = 50_000 * 40;
    await until("jump", settled);
    await sleep(300);
    for (const [dir, dy] of [["down", 600], ["up", -600]]) {
      const res = [];
      for (let i = 0; i < 120; i++) res.push(await step(`${dir} ${i}`, dy));
      out[`steps ${dir}: ms to filled`] = stats(res.map((x) => x.t));
      out[`steps ${dir}: steps with wrong rows`] = res.filter((x) => x.wrong > 0).length;
      out[`steps ${dir}: never filled`] = res.filter((x) => Number.isNaN(x.t)).length;
    }
    for (const [dir, dy] of [["down", 200], ["up", -200]]) {
      let skel = 0;
      let streak = 0;
      let worst = 0;
      let wrong = 0;
      for (let i = 0; i < 600; i++) {
        scroller().scrollTop += dy;
        await frame();
        const view = scroller().getBoundingClientRect();
        const visibleSkel = [...document.querySelectorAll("[data-skeleton]")].some((s) => {
          const b = s.getBoundingClientRect();
          return b.bottom > view.top && b.top < view.bottom;
        });
        if (visibleSkel) {
          skel++;
          worst = Math.max(worst, ++streak);
        } else streak = 0;
        if (wrongRows(expected, mods) > 0) wrong++;
      }
      await until(`fling ${dir} settles`, settled, 3000);
      out[`fling ${dir} 5 rows/frame x600: frames with skeletons in view`] = skel;
      out[`fling ${dir}: longest skeleton streak, frames`] = worst;
      out[`fling ${dir}: frames with wrong rows`] = wrong;
      out[`fling ${dir}: wrong rows once settled`] = wrongRows(expected, mods);
    }
    out.heldAfterScroll = store.issues.size;
  }

  if (truth.mode === "live") {
    const { commands } = globalThis.__linearlite;
    const target = 50_000;
    scroller().scrollTop = target * 40;
    await until("jump", settled);
    await sleep(500);
    for (const [where, pick] of [
      ["above", () => 100],
      ["inside", () => target + 5],
      ["below", () => 60_000],
    ]) {
      const ids = await order(61_000);
      const mods = await modifiedOf(ids.slice(target - 2000, target + 2000));
      const at = pick();
      const x = ids[at];
      const doc = (await issues.getMany([x]))[0];
      const expected = (i) => (i === 0 ? x : i <= at ? ids[i - 1] : ids[i]);
      const wrongBefore = wrongRows((i) => ids[i], mods);
      const t0 = performance.now();
      await commands.setStatus(x, (doc.status + 1) % 5);
      let wrongFrames = 0;
      let lastFix = 0;
      let wasWrong = false;
      while (performance.now() - t0 < 2500) {
        await frame();
        const w = !settled() || wrongRows(expected, mods) > 0;
        if (w) wrongFrames++;
        if (wasWrong && !w) lastFix = performance.now() - t0;
        wasWrong = w;
      }
      out[`edit ${where} (row ${at})`] = { wrongBefore, wrongFrames, correctFromMs: r1(lastFix), wrongAtEnd: wrongRows(expected, mods) };
      await sleep(400);
    }
  }
  out.failures = failures;
  return JSON.stringify(out);
})(__TRUTH__)
