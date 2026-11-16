import { HardDrive, Server } from "lucide-react";
import { Connector, Stage, Swap, type Rect } from "../kit";
import { ACCENT, tokens, type SceneTheme } from "../look.ts";
import { SIZES } from "../sizes.ts";
import "./fits.css";

// Where opfs-lsm sits in an app, for one use case, as a still. A server syncs with a library in the browser, and
// that library stores what it keeps in opfs-lsm through an adapter. opfs-lsm, the one accent in the figure, is the
// column's foot, with OPFS named inside it as where it writes.
//
// The home page's use cases pick the case and its adapter. Picking another swaps the words in place; the boxes stay
// put, since every case names one library and one package.

type Case = { readonly library: string; readonly stores: string; readonly package: string };
type Props = { readonly theme: SceneTheme; readonly case: Case };

const GAP = 5;

export default function Fits({ theme, case: c }: Props) {
  const [width, height] = SIZES.fits.wide;
  return (
    <Stage width={width} height={height} initial={{}} theme={theme} accent={ACCENT} tokens={tokens(theme)} className="fi">
      {(_, rect) => {
        const srv = rect("srv");
        const lib = rect("lib");
        const lsm = rect("lsm");
        const placed = srv.width > 0 && lib.width > 0 && lsm.width > 0;
        return (
          <>
            <div className="fi-col">
              <div className="fi-server" data-target="srv">
                <Server size={14} strokeWidth={1.5} absoluteStrokeWidth aria-hidden />
                <span>Server</span>
              </div>
              <div className="fi-lib" data-target="lib">
                <Swap id={c.library}>{c.library}</Swap>
              </div>
              <div className="fi-lsm" data-target="lsm">
                <span className="fi-lsm-name">opfs-lsm</span>
                <Swap id={c.package} className="fi-package">
                  {c.package}
                </Swap>
                <span className="fi-opfs">
                  <HardDrive size={14} strokeWidth={1.5} absoluteStrokeWidth aria-hidden />
                  <span className="fi-opfs-name">OPFS</span>
                  <span>the browser's file storage for your site</span>
                </span>
              </div>
            </div>
            {placed && (
              <>
                <Connector
                  className="fi-sync"
                  show
                  route="straight"
                  dots="none"
                  dashed
                  label="sync"
                  from={{ x: mid(srv), y: srv.y + srv.height + GAP }}
                  to={{ x: mid(srv), y: lib.y - GAP }}
                />
                <Connector
                  show
                  route="straight"
                  arrow
                  label={<Swap id={c.stores}>{c.stores}</Swap>}
                  from={{ x: mid(lib), y: lib.y + lib.height + GAP }}
                  to={{ x: mid(lib), y: lsm.y - GAP }}
                />
              </>
            )}
          </>
        );
      }}
    </Stage>
  );
}

function mid(r: Rect) {
  return r.x + r.width / 2;
}
