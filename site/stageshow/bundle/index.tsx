import { Bar, Code, Row, Stage, Text, Window, type Act } from "../kit";
import { ACCENT, tokens, type SceneTheme } from "../look.ts";
import { COMPACT_BELOW, SIZES } from "../sizes.ts";
import "./bundle.css";

// What a page downloads for kv, and when. No cursor: the line the page is running is marked in the editor, as a
// debugger marks it. It starts on the import, with one file downloaded and two rows still placeholders. The click
// handler runs, the mark moves to the call to openDb, and the two rows resolve into the SharedWorker chunk and
// the wasm engine. The figure in large type stays the cost of the import; what loads later is added under it. A
// row and its placeholder share one cell, so nothing moves when the words arrive. Plays once; the still is the
// three files.
//
// Every size comes from the page's frontmatter, which the build checks against README.md.

type Props = { readonly theme: SceneTheme; readonly main: string; readonly worker: string; readonly wasm: string; readonly lazy: string };

/** `line`: the index of the line being run. `opened`: lazy files that have arrived. `sum`: their size shows. */
type S = { line: number; opened: number; sum: boolean };

const WIDE = [
  'import { openDb } from "@opfs-lsm/kv";',
  'import { render } from "./ui";',
  "",
  "render(document.body);",
  "",
  "async function openNotes() {",
  '  return openDb({ name: "notes" });',
  "}",
  "",
  "open.onclick = async () => {",
  "  const db = await openNotes();",
  "  const text = new TextEncoder();",
  "  await db.put(",
  '    text.encode("note:1"),',
  '    text.encode("Buy milk"),',
  "  );",
  "};",
];
const COMPACT = ['import { openDb } from "@opfs-lsm/kv";', "", "async function openNotes() {", '  return openDb({ name: "notes" });', "}"];
/** The line of the click handler, where the layout shows it, and the line that calls openDb. */
const CLICK = { wide: 9, compact: undefined } as const;
const CALL = { wide: 6, compact: 3 } as const;
const LINE = 19;

async function script(a: Act<S>) {
  await a.wait(1400);
  const click = CLICK[a.layout];
  if (click !== undefined) {
    a.mark("click");
    a.put({ line: click });
    await a.wait(1000);
  }
  a.mark("call");
  a.put({ line: CALL[a.layout] });
  await a.wait(900);
  a.mark("load");
  a.put({ opened: 1 });
  await a.wait(260);
  a.put({ opened: 2 });
  await a.wait(500);
  a.mark("total");
  a.put({ sum: true });
  await a.wait(1600);
}

function Editor({ lines, at }: { lines: string[]; at: number }) {
  return (
    <div className="bd-editor">
      <span className="bd-running" style={{ translate: `0 ${at * LINE}px` }} />
      <Code lines={lines} />
    </div>
  );
}

export default function Bundle({ theme, main, worker, wasm, lazy: later }: Props) {
  const { wide, compact } = SIZES.bundle;
  const lazy = [
    { name: "SharedWorker", size: worker, bar: 84 },
    { name: "wasm engine", size: wasm, bar: 74 },
  ];
  return (
    <Stage<S>
      width={wide[0]}
      height={wide[1]}
      compact={{ below: COMPACT_BELOW, width: compact[0], height: compact[1] }}
      initial={{ line: 0, opened: 0, sum: false }}
      poster={{ line: -1, opened: 2, sum: true }}
      script={script}
      play="once"
      theme={theme}
      accent={ACCENT}
      tokens={tokens(theme)}
      className="bd"
    >
      {(s, _rect, layout) => {
        const at = s.line < 0 ? CALL[layout] : s.line;
        return (
          <>
            {layout === "wide" ? (
              <Window
                title="notes.ts"
                className="bd-win"
                sidebarWidth={140}
                sidebar={
                  <div className="bd-files">
                    {[62, 84, 54, 76, 48, 80].map((w, i) => (
                      <Bar key={w} w={w} h={7} r={3.5} tone={i === 1 ? 4 : 2} />
                    ))}
                  </div>
                }
              >
                <Editor lines={WIDE} at={at} />
              </Window>
            ) : (
              <Window title="notes.ts" className="bd-win">
                <Editor lines={COMPACT} at={at} />
              </Window>
            )}

            <section className="bd-card">
              <Text className="bd-label">At import</Text>
              <div className="bd-total">{main}</div>
              <div className="bd-later" data-in={s.sum || undefined}>
                <b>+{later}</b> on the first openDb
              </div>
              <div className="bd-list">
                <Row pad={0} className="bd-row" title={<Text>Main-thread JS</Text>} subtitle={<Text>at import</Text>} meta={main} />
                {lazy.map((file, i) => (
                  <div key={file.name} className="bd-slot" data-ready={s.opened > i || undefined}>
                    <Row
                      pad={0}
                      className="bd-row bd-pending"
                      title={<Bar w={file.bar} h={7} r={3.5} tone={2} />}
                      subtitle={<Bar w={96} h={6} r={3} tone={1} />}
                      meta={<Bar w={40} h={7} r={3.5} tone={2} />}
                    />
                    <Row pad={0} className="bd-row bd-loaded" title={<Text>{file.name}</Text>} subtitle={<Text>on the first openDb</Text>} meta={file.size} />
                  </div>
                ))}
              </div>
            </section>
          </>
        );
      }}
    </Stage>
  );
}
