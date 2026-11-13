import type { PriorityCode, StatusCode } from "../domain/model.ts";

const S = { width: 14, height: 14, viewBox: "0 0 14 14", fill: "none", className: "ico" } as const;

export function StatusIcon({ status }: { status: StatusCode }) {
  return (
    <span className={`st-${status}`} style={{ display: "inline-flex" }}>
      <svg {...S} aria-hidden>
        {status === 0 && <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.2 2.2" />}
        {status === 1 && <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.5" />}
        {status === 2 && (
          <>
            <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.5" />
            <path d="M7 3.5a3.5 3.5 0 0 1 0 7z" fill="currentColor" />
          </>
        )}
        {status === 3 && (
          <>
            <circle cx="7" cy="7" r="6.25" fill="currentColor" />
            <path d="M4.3 7.2l1.9 1.9 3.5-3.7" stroke="var(--bg)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </>
        )}
        {status === 4 && (
          <>
            <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.5" />
            <path d="M5 5l4 4M9 5l-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </>
        )}
      </svg>
    </span>
  );
}

const BARS: Record<PriorityCode, number> = { 0: 3, 1: 3, 2: 2, 3: 1, 4: 0 };

export function PriorityIcon({ priority }: { priority: PriorityCode }) {
  return (
    <span className={`pr-${priority}`} style={{ display: "inline-flex" }}>
      <svg {...S} aria-hidden>
        {priority === 0 ? (
          <>
            <rect x="1.5" y="1.5" width="11" height="11" rx="3" fill="currentColor" />
            <path d="M7 4v3.6M7 9.4v.6" stroke="var(--bg)" strokeWidth="1.5" strokeLinecap="round" />
          </>
        ) : (
          [0, 1, 2].map((i) => (
            <rect
              key={i}
              x={1.5 + i * 4}
              y={9 - i * 3}
              width="2.6"
              height={3.5 + i * 3}
              rx="0.8"
              fill="currentColor"
              opacity={i < BARS[priority] ? 1 : 0.28}
            />
          ))
        )}
      </svg>
    </span>
  );
}

export function Check() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path d="M2.5 6.3l2.4 2.4 4.6-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
