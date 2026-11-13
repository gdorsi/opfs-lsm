import { HardDrive, Server } from "lucide-react";
import { Connector, Stage, type Rect } from "../kit";
import { ACCENT, tokens, type SceneTheme } from "../look.ts";
import { FULL_COMPACT_BELOW, SIZES } from "../sizes.ts";
import "./fits.css";

// Where opfs-lsm sits in an app, one column per use case, as a still. In every column a server syncs with a library
// in the browser, and that library stores what it keeps in opfs-lsm through an adapter, which writes to OPFS. The
// opfs-lsm nodes sit at one height in every column, the one accent in the figure, over one disk.
//
// Every word but the structural ones comes from the page's frontmatter.

type Case = {
  readonly name: string;
  readonly package: string;
  readonly case: string;
  readonly detail: string;
  readonly library: string;
  readonly stores: string;
};
type Props = { readonly theme: SceneTheme; readonly cases: readonly Case[] };

const GAP = 5;

export default function Fits({ theme, cases }: Props) {
  const { wide, compact } = SIZES.fits;
  return (
    <Stage
      width={wide[0]}
      height={wide[1]}
      compact={{ below: FULL_COMPACT_BELOW, width: compact[0], height: compact[1] }}
      initial={{}}
      theme={theme}
      accent={ACCENT}
      tokens={tokens(theme)}
      className="fi"
    >
      {(_, rect, layout) => {
        const lines = cases.map((c, i) => {
          const srv = rect(`srv-${i}`);
          const lib = rect(`lib-${i}`);
          const lsm = rect(`lsm-${i}`);
          const isWide = layout === "wide";
          const disk = rect("disk");
          if (!srv.width || !lib.width || !lsm.width) return null;
          const sync = isWide
            ? { from: { x: mid(srv), y: srv.y + srv.height + GAP }, to: { x: mid(lib), y: lib.y - GAP } }
            : {
                from: { x: srv.x + srv.width + GAP, y: srv.y + srv.height / 2 },
                to: { x: lib.x - GAP, y: srv.y + srv.height / 2 },
              };
          return (
            <span key={c.name}>
              <span className={isWide ? undefined : "fi-sync-label"}>
                <Connector
                  className="fi-sync"
                  show
                  route="straight"
                  dots="none"
                  dashed
                  label="sync"
                  {...sync}
                />
              </span>
              {/* Down the middle of opfs-lsm: narrow, opfs-lsm spans the card and the library sits right of the
                  server, so the label stays inside the card. */}
              <Connector
                show
                route="straight"
                arrow
                label={c.stores}
                from={{ x: mid(lsm), y: lib.y + lib.height + GAP }}
                to={{ x: mid(lsm), y: lsm.y - GAP }}
              />
              {isWide && disk.width > 0 && (
                <Connector
                  className="fi-disk"
                  show
                  route="straight"
                  dots="none"
                  from={{ x: mid(lsm), y: lsm.y + lsm.height }}
                  to={{ x: mid(lsm), y: disk.y }}
                />
              )}
            </span>
          );
        });
        return (
          <>
            <section className="fi-card">
              <div className="fi-cols">
                {cases.map((c, i) => (
                  <div key={c.name} className="fi-col">
                    <div className="fi-head">
                      <span className="fi-case">{c.case}</span>
                      <span className="fi-detail">{c.detail}</span>
                    </div>
                    <div className="fi-sync-row">
                      <div className="fi-slot fi-slot--server" data-target={`srv-${i}`}>
                        <div className="fi-server">
                          <Server size={14} strokeWidth={1.5} absoluteStrokeWidth aria-hidden />
                          <span>Server</span>
                        </div>
                      </div>
                      <div className="fi-slot fi-slot--lib" data-target={`lib-${i}`}>
                        <div className="fi-lib">{c.library}</div>
                      </div>
                    </div>
                    <div className="fi-lsm" data-target={`lsm-${i}`}>
                      <span className="fi-lsm-name">opfs-lsm</span>
                      <span className="fi-packages">
                        {c.package.split(/,\s*/).map((p) => (
                          <span key={p}>{p}</span>
                        ))}
                      </span>
                      <span className="fi-opfs-inline">
                        <HardDrive size={14} strokeWidth={1.5} absoluteStrokeWidth aria-hidden />
                        OPFS
                      </span>
                    </div>
                  </div>
                ))}
              </div>
              <div className="fi-disk-band" data-target="disk">
                <HardDrive size={16} strokeWidth={1.5} absoluteStrokeWidth aria-hidden />
                <span className="fi-disk-name">OPFS</span>
                <span className="fi-disk-what">the browser's file storage for your site</span>
              </div>
            </section>
            {lines}
          </>
        );
      }}
    </Stage>
  );
}

function mid(r: Rect) {
  return r.x + r.width / 2;
}
