import { Badge, Bar, Collapse, Connector, Row, Stage, Text, type Act } from "../kit";
import { ACCENT, tokens, type SceneTheme } from "../look.ts";
import { COMPACT_BELOW, SIZES } from "../sizes.ts";
import "./stack.css";

// What kv does with a write, as a system story with no cursor. A tab puts a record, which lands as a row of the
// write-ahead log in IndexedDB beside the two already there: that row is the ack. The SharedWorker flushes the
// three into one SST file in OPFS, named after the records it holds, and truncates the log. The next record
// starts the log again, and the tab reads the files itself. Plays once; the still is the whole path.
//
// Both lists show the newest first, so a new row arrives at the top and carries the older ones down.

type Props = { readonly theme: SceneTheme };

/**
 * `put`, `flush`, `read`: the three lines. `acked`: the put is in the log. `flushed`: the file exists and the
 * log is truncated. `next`: a record has arrived after the flush.
 */
type S = { put: boolean; acked: boolean; flush: boolean; flushed: boolean; next: boolean; read: boolean };

const START: S = { put: false, acked: false, flush: false, flushed: false, next: false, read: false };
const END: S = { put: true, acked: true, flush: true, flushed: true, next: true, read: true };

const WHO = "your code, or an adapter over kv";
const FILE = "l0/41-43.sst";
const OLDER_FILES = ["l0/36-40.sst", "l1/c7.0.sst", "l1/c7.1.sst"];

async function script(a: Act<S>) {
  await a.wait(800);
  a.mark("put");
  a.put({ put: true });
  await a.wait(900);
  a.put({ acked: true });
  await a.wait(1200);
  a.mark("flush");
  a.put({ flush: true });
  await a.wait(1100);
  a.put({ flushed: true });
  await a.wait(1500);
  a.mark("next");
  a.put({ next: true });
  await a.wait(1200);
  a.mark("read");
  a.put({ read: true });
  await a.wait(1600);
}

function Record({ seq, open }: { seq: number; open: boolean }) {
  return (
    <Collapse open={open}>
      <Row pad={0} className="sk-row" title={<Text className="sk-mono">{`record ${seq}`}</Text>}>
        <Badge tone="success">acked</Badge>
      </Row>
    </Collapse>
  );
}

export default function Stack({ theme }: Props) {
  const { wide, compact } = SIZES.stack;
  return (
    <Stage<S>
      width={wide[0]}
      height={wide[1]}
      compact={{ below: COMPACT_BELOW, width: compact[0], height: compact[1] }}
      initial={START}
      poster={END}
      script={script}
      play="once"
      theme={theme}
      accent={ACCENT}
      tokens={tokens(theme)}
      className="sk"
    >
      {(s, rect, layout) => {
        const tab = rect("tab");
        const wal = rect("wal");
        const sst = rect("sst");
        const rows = rect("records");
        const measured = tab.width > 0 && wal.width > 0 && sst.width > 0;
        const walX = wal.x + wal.width / 2;
        const sstX = sst.x + sst.width / 2;
        return (
          <>
            {layout === "compact" && <div className="sk-sheet" />}
            <section className="sk-tab" data-target="tab">
              <Text className="sk-title">A tab of your app</Text>
              <Text className="sk-where">{WHO}</Text>
            </section>

            <section className="sk-store sk-wal" data-target="wal">
              <header className="sk-head">
                <Text className="sk-title">Write-ahead log</Text>
                <Text className="sk-where">IndexedDB</Text>
              </header>
              <div data-target="records">
                <Record seq={44} open={s.next} />
                <Record seq={43} open={s.acked && !s.flushed} />
                <Record seq={42} open={!s.flushed} />
                <Record seq={41} open={!s.flushed} />
                <Collapse open={s.flushed}>
                  <Row pad={0} className="sk-row" title={<Text className="sk-mono">41 to 43</Text>}>
                    <Badge>truncated</Badge>
                  </Row>
                </Collapse>
              </div>
              {[64, 52, 60, 56].map((w, i) => (
                <Row key={i} pad={0} className="sk-row" title={<Bar w={w} h={7} r={3.5} tone={2} />}>
                  <Bar w={50} h={20} r={10} tone={1} />
                </Row>
              ))}
            </section>

            <section className="sk-store sk-sst" data-target="sst">
              <header className="sk-head">
                <Text className="sk-title">SST files</Text>
                <Text className="sk-where">OPFS</Text>
                <span className="sk-note" data-in={(layout === "compact" && s.read) || undefined}>
                  read by the tab
                </span>
              </header>
              <Collapse open={s.flushed}>
                <Row pad={0} className="sk-row" title={<Text className="sk-mono sk-new">{FILE}</Text>} />
              </Collapse>
              {OLDER_FILES.map((name) => (
                <Row key={name} pad={0} className="sk-row" title={<Text className="sk-mono">{name}</Text>} />
              ))}
              {[92, 84].map((w, i) => (
                <Row key={i} pad={0} className="sk-row" title={<Bar w={w} h={7} r={3.5} tone={2} />} />
              ))}
            </section>

            {measured && (
              <>
                <Connector show={s.put} route="straight" arrow label="put" from={{ x: walX, y: tab.y + tab.height + 5 }} to={{ x: walX, y: wal.y - 5 }} />
                {layout === "wide" ? (
                  <>
                    <Connector
                      show={s.flush}
                      route="straight"
                      arrow
                      label="SharedWorker"
                      from={{ x: wal.x + wal.width + 5, y: rows.y + 17 }}
                      to={{ x: sst.x - 5, y: rows.y + 17 }}
                    />
                    <Connector show={s.read} route="straight" arrow label="get" from={{ x: sstX, y: sst.y - 5 }} to={{ x: sstX, y: tab.y + tab.height + 5 }} />
                  </>
                ) : (
                  <Connector show={s.flush} route="straight" arrow label="SharedWorker" from={{ x: walX, y: wal.y + wal.height + 5 }} to={{ x: walX, y: sst.y - 5 }} />
                )}
              </>
            )}
          </>
        );
      }}
    </Stage>
  );
}
