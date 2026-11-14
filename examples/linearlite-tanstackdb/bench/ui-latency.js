// Run in a page showing /issues with default filters. `bench/client.ts` fills in the argument on the last line: the
// expected totals, search counts, top rows and scroll targets, computed from the server's rows. The script reads only the DOM,
// so it times any build of the app, and a step passes only when the rows and the toolbar total are both right.
(async (truth) => {
  const RUNS = 10;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
        failures.push({ what, rows: rows().length, skeletons: document.querySelectorAll("[data-skeleton]").length, total: total(), url: location.search });
        return NaN;
      }
      await new Promise((r) => requestAnimationFrame(r));
    }
  };
  const rows = () => [...document.querySelectorAll(".row[data-id]")];
  const settled = () => rows().length > 0 && !document.querySelector("[data-skeleton]");
  const total = () => document.getElementById("count")?.textContent ?? "";
  const shown = (n) => n.toLocaleString("en-US");
  const stats = (v) => {
    const failed = v.filter((x) => Number.isNaN(x)).length;
    const s = v.filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
    const r = (x) => Math.round(x * 10) / 10;
    return s.length === 0 ? { n: 0, failed } : { n: s.length, failed, p50: r(s[Math.floor((s.length - 1) / 2)]), min: r(s[0]), max: r(s.at(-1)) };
  };
  const item = (label) => [...document.querySelectorAll("[role=menuitem]")].find((b) => b.textContent.startsWith(label));
  const button = (title) => document.querySelector(`.chip[title="${title}"]`);
  const appear = async (get) => {
    for (let i = 0; i < 250; i++) {
      const v = get();
      if (v) return v;
      await sleep(20);
    }
    throw new Error("element never appeared");
  };
  const openMenu = async (title, entry) => {
    if (!item(entry)) (await appear(() => button(title))).click();
    return appear(() => item(entry));
  };
  const escape = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  const out = {};

  await until("start", () => settled() && total() === shown(truth.total));

  const STATUSES = ["Backlog", "Todo", "In Progress", "Done", "Canceled"];
  const on = [];
  const off = [];
  for (let i = 0; i < RUNS; i++) {
    const k = i % 5;
    const entry = await openMenu("Filter by status", STATUSES[k]);
    await sleep(60);
    const t0 = performance.now();
    entry.click();
    on.push((await until(`status ${k} on`, () => settled() && total() === shown(truth.byStatus[k]) && rows().every((r) => r.dataset.status === String(k)))) - t0);
    await sleep(150);
    const again = await openMenu("Filter by status", STATUSES[k]);
    const t1 = performance.now();
    again.click();
    off.push((await until(`status ${k} off`, () => settled() && total() === shown(truth.total))) - t1);
    escape();
    await sleep(150);
  }
  out["status chip on -> rows and total painted"] = stats(on);
  out["status chip off -> rows and total painted"] = stats(off);

  const PRIORITIES = ["Urgent", "High", "Medium", "Low", "No priority"];
  const prio = [];
  for (let i = 0; i < RUNS; i++) {
    const k = i % 5;
    const entry = await openMenu("Filter by priority", PRIORITIES[k]);
    await sleep(60);
    const t0 = performance.now();
    entry.click();
    prio.push((await until(`priority ${k} on`, () => settled() && total() === shown(truth.byPriority[k]) && rows().every((r) => r.dataset.priority === String(k)))) - t0);
    await sleep(150);
    (await openMenu("Filter by priority", PRIORITIES[k])).click();
    await until(`priority ${k} off`, () => settled() && total() === shown(truth.total));
    escape();
    await sleep(150);
  }
  out["priority filter on -> rows and total painted"] = stats(prio);

  const first = () => rows().find((r) => r.dataset.index === "0");
  const sortTo = async (to, ready) => {
    const entry = await openMenu("Sort", to);
    await sleep(60);
    const t0 = performance.now();
    entry.click();
    return (await until(`sort ${to}`, () => settled() && ready())) - t0;
  };
  const tops = { Created: new Set(truth.topCreated), Modified: new Set(truth.topModified) };
  const sorts = [];
  for (let i = 0; i < RUNS; i++) {
    const to = i % 2 === 0 ? "Created" : "Modified";
    sorts.push(await sortTo(to, () => tops[to].has(first()?.dataset.id)));
    await sleep(200);
  }
  out["sort modified <-> created -> rows painted"] = stats(sorts);
  const toPriority = [];
  for (let i = 0; i < RUNS / 2; i++) {
    toPriority.push(await sortTo("Priority", () => first()?.dataset.priority === "4" && rows().every((r) => r.dataset.priority === "4")));
    await sleep(200);
    await sortTo("Modified", () => tops.Modified.has(first()?.dataset.id));
    await sleep(200);
  }
  out["sort modified -> priority -> rows painted"] = stats(toPriority);
  const toStatus = [];
  for (let i = 0; i < RUNS / 2; i++) {
    toStatus.push(await sortTo("Status", () => first()?.dataset.status === "4" && rows().every((r) => r.dataset.status === "4")));
    await sleep(200);
    await sortTo("Modified", () => tops.Modified.has(first()?.dataset.id));
    await sleep(200);
  }
  out["sort modified -> status -> rows painted"] = stats(toStatus);

  const input = document.getElementById("search");
  const type = (value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const keys = [];
  for (const { before, term, count } of truth.search) {
    type(before);
    await sleep(700);
    const t0 = performance.now();
    type(term);
    keys.push((await until(`search ${term}`, () => settled() && total() === shown(count) && rows().every((r) => r.querySelector(".name").textContent.toLowerCase().includes(term)))) - t0);
    await sleep(150);
  }
  type("");
  await until("search cleared", () => settled() && total() === shown(truth.total));
  out["search keystroke -> rows and total painted (80 ms debounce included)"] = stats(keys);

  const nav = [];
  for (let i = 0; i < RUNS; i++) {
    const row = rows().find((r) => r.dataset.index === String(5 + i));
    const title = row.querySelector(".name").textContent;
    const t0 = performance.now();
    row.querySelector(".name").click();
    nav.push((await until("detail", () => document.getElementById("title")?.value === title)) - t0);
    await sleep(200);
    history.back();
    await until("back", settled);
    await sleep(200);
  }
  out["list -> detail, title painted"] = stats(nav);

  const scroller = () => document.getElementById("scroller");
  for (const { target, ids, runs } of truth.jumps) {
    const accepted = new Set(ids);
    const jumps = [];
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      scroller().scrollTop = target * 40;
      jumps.push(
        (await until(`jump ${target}`, () => settled() && accepted.has(document.querySelector(`.row[data-index="${target}"]`)?.dataset.id))) - t0,
      );
      await sleep(150);
      scroller().scrollTop = 0;
      await until("top", () => settled() && !!document.querySelector('.row[data-index="0"]'));
      await sleep(150);
    }
    out[`scroll jump to row ${target} -> rows painted`] = { ...stats(jumps), first: Math.round(jumps[0] * 10) / 10 };
  }
  out.failures = failures;
  return JSON.stringify(out);
})(__TRUTH__)
