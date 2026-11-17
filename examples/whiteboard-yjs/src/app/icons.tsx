import type { ReactNode } from "react";

export function Icon({ children, size = 20 }: { children: ReactNode; size?: number }): ReactNode {
  return (
    <svg
      viewBox="0 0 20 20"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const ICON = {
  select: <path d="M5.5 3.5l10 6-4.7 1.3-2 4.7z" />,
  rect: <rect x="3.5" y="5" width="13" height="10" rx="1.5" />,
  ellipse: <ellipse cx="10" cy="10" rx="7" ry="5.5" />,
  diamond: <path d="M10 3l7 7-7 7-7-7z" />,
  arrow: <path d="M4 16L16 4m0 0H9.5M16 4v6.5" />,
  text: <path d="M4.5 5.5v-2h11v2M10 3.5v13M7.5 16.5h5" />,
  pen: <path d="M3.5 15.5c2.5-.6 3.3-4 5.2-5.7s3.5-1 4.6-2.6 1.4-2.6 3.2-3.2" />,
  undo: (
    <>
      <path d="M8 4.5L4.5 8 8 11.5" />
      <path d="M4.5 8H12a4 4 0 0 1 0 8H9.5" />
    </>
  ),
  redo: (
    <>
      <path d="M12 4.5L15.5 8 12 11.5" />
      <path d="M15.5 8H8a4 4 0 0 0 0 8h2.5" />
    </>
  ),
  minus: <path d="M5 10h10" />,
  plus: <path d="M10 5v10M5 10h10" />,
  fit: <path d="M3.5 7.5v-4h4M12.5 3.5h4v4M16.5 12.5v4h-4M7.5 16.5h-4v-4" />,
  duplicate: (
    <>
      <rect x="7" y="7" width="9.5" height="9.5" rx="1.5" />
      <path d="M13 7V5a1.5 1.5 0 0 0-1.5-1.5H5A1.5 1.5 0 0 0 3.5 5v6.5A1.5 1.5 0 0 0 5 13h2" />
    </>
  ),
  trash: <path d="M4 6h12M8.5 6V4h3v2M5.5 6l.8 9.6A1.5 1.5 0 0 0 7.8 17h4.4a1.5 1.5 0 0 0 1.5-1.4L14.5 6" />,
  toFront: <path d="M10 16.5V7M6 11l4-4 4 4M5 3.5h10" />,
  forward: <path d="M10 15.5v-11M6 8.5l4-4 4 4" />,
  backward: <path d="M10 4.5v11M6 11.5l4 4 4-4" />,
  toBack: <path d="M10 3.5V13M6 9l4 4 4-4M5 16.5h10" />,
  back: <path d="M12 4.5L6.5 10l5.5 5.5" />,
  help: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M8 8.2a2 2 0 1 1 2.9 1.8c-.6.3-.9.8-.9 1.3v.4" />
      <path d="M10 14.1v.1" />
    </>
  ),
  rename: (
    <>
      <path d="M12.5 4.5l3 3L7 16H4v-3z" />
      <path d="M11 6l3 3" />
    </>
  ),
  saved: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M7 10.2l2 2 4-4.4" />
    </>
  ),
  saving: (
    <>
      <path d="M16 10a6 6 0 1 1-1.8-4.3" />
      <path d="M16 3.5v3h-3" />
    </>
  ),
  alert: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M10 6.5v4M10 13.5v.1" />
    </>
  ),
  info: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M10 9v4.5M10 6.5v.1" />
    </>
  ),
  close: <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />,
  code: <path d="M7 6l-4 4 4 4M13 6l4 4-4 4" />,
} satisfies Record<string, ReactNode>;

export function Mark({ size = 24 }: { size?: number }): ReactNode {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" className="mark">
      <rect width="24" height="24" rx="6.5" fill="var(--ink)" />
      <rect x="5.5" y="6" width="8" height="7" rx="1.5" fill="none" stroke="#fff" strokeWidth="1.7" />
      <circle cx="15.5" cy="15.5" r="3.6" fill="var(--accent)" stroke="#fff" strokeWidth="1.7" />
    </svg>
  );
}
