(async () => {
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
  const until = async (ready, timeout = 5000) => {
    const end = performance.now() + timeout;
    for (;;) {
      if (ready()) return paint();
      if (performance.now() > end) throw new Error("timed out");
      await new Promise((r) => requestAnimationFrame(r));
    }
  };
  const rows = () => [...document.querySelectorAll("[data-id]")];
  const settled = () => rows().length > 0 && !document.querySelector("[data-skeleton]");
  const stats = (v) => {
    const s = [...v].sort((a, b) => a - b);
    const r = (x) => Math.round(x * 10) / 10;
    return { n: s.length, p50: r(s[Math.floor((s.length - 1) / 2)]), min: r(s[0]), max: r(s.at(-1)) };
  };
  const menuItem = (label) => [...document.querySelectorAll("[role=menuitem]")].find((b) => b.textContent.startsWith(label));
  const chip = (name) => [...document.querySelectorAll(".chip")].find((b) => b.textContent.startsWith(name));
  const total = () => document.getElementById("count").textContent;
  const out = {};

  const STATUSES = ["Backlog", "Todo", "In Progress", "Done", "Canceled"];
  const baseline = total();
  const on = [];
  const off = [];
  for (let i = 0; i < RUNS; i++) {
    const k = i % 5;
    chip("Status").click();
    await sleep(60);
    const t0 = performance.now();
    menuItem(STATUSES[k]).click();
    on.push((await until(() => settled() && rows().every((r) => r.dataset.status === String(k)))) - t0);
    await sleep(150);
    const t1 = performance.now();
    menuItem(STATUSES[k]).click();
    off.push((await until(() => settled() && total() === baseline)) - t1);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(150);
  }
  out["status chip on -> rows painted"] = stats(on);
  out["status chip off -> rows painted"] = stats(off);

  const input = document.getElementById("search");
  const type = (value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const matching = (text) => __linearlite.store.issues.toArray.filter((i) => !i.deleted && i.title.toLowerCase().includes(text)).length;
  const pairs = [["of", "off"], ["ta", "tab"], ["ma", "mag"], ["cu", "cur"], ["ni", "nis"], ["ex", "exc"], ["do", "dol"], ["in", "ind"], ["qu", "que"], ["la", "lab"], ["re", "ren"], ["se", "sed"], ["co", "com"], ["su", "sun"]]
    .filter(([before, term]) => matching(before) !== matching(term))
    .slice(0, RUNS);
  const keys = [];
  for (const [before, term] of pairs) {
    type(before);
    await sleep(700);
    const want = matching(term).toLocaleString("en-US");
    const t0 = performance.now();
    type(term);
    keys.push((await until(() => settled() && total() === want && rows().every((r) => r.querySelector(".name").textContent.toLowerCase().includes(term)))) - t0);
    await sleep(150);
  }
  type("");
  await until(() => settled() && total() === baseline);
  out["search keystroke -> rows painted (80 ms debounce included)"] = stats(keys);

  const nav = [];
  for (let i = 0; i < RUNS; i++) {
    const row = rows().find((r) => r.dataset.index === String(5 + i));
    const title = row.querySelector(".name").textContent;
    const t0 = performance.now();
    row.querySelector(".name").click();
    nav.push((await until(() => document.getElementById("title")?.value === title)) - t0);
    await sleep(200);
    history.back();
    await until(settled);
    await sleep(200);
  }
  out["list -> detail, title painted"] = stats(nav);
  return JSON.stringify(out, null, 1);
})()
