import type { JSX } from "@solidjs/web";
import type { ParentProps } from "solid-js";
import type { Code } from "./model.ts";

const Svg = (props: ParentProps) => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" class="ico" aria-hidden="true">
    {props.children}
  </svg>
);
const Ring = () => <circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.5" />;

const STATUS: readonly (() => JSX.Element)[] = [
  () => <circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2.2 2.2" />,
  () => <Ring />,
  () => (
    <>
      <Ring />
      <path d="M7 3.5a3.5 3.5 0 0 1 0 7z" fill="currentColor" />
    </>
  ),
  () => (
    <>
      <circle cx="7" cy="7" r="6.25" fill="currentColor" />
      <path d="M4.3 7.2l1.9 1.9 3.5-3.7" stroke="var(--bg)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
    </>
  ),
  () => (
    <>
      <Ring />
      <path d="M5 5l4 4M9 5l-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
    </>
  ),
];

const BARS = [3, 3, 2, 1, 0];

export const StatusIcon = (props: { code: Code }) => (
  <span class={[`st-${props.code}`, "ico-wrap"]}>
    <Svg>{STATUS[props.code]!()}</Svg>
  </span>
);

export const PriorityIcon = (props: { code: Code }) => (
  <span class={[`pr-${props.code}`, "ico-wrap"]}>
    <Svg>
      {props.code === 0 ? (
        <>
          <rect x="1.5" y="1.5" width="11" height="11" rx="3" fill="currentColor" />
          <path d="M7 4v3.6M7 9.4v.6" stroke="var(--bg)" stroke-width="1.5" stroke-linecap="round" />
        </>
      ) : (
        [0, 1, 2].map((i) => (
          <rect x={1.5 + i * 4} y={9 - i * 3} width="2.6" height={3.5 + i * 3} rx="0.8" fill="currentColor" opacity={i < BARS[props.code]! ? 1 : 0.28} />
        ))
      )}
    </Svg>
  </span>
);

export const Dots = () => (
  <Svg>
    <circle cx="2.5" cy="7" r="1.25" fill="currentColor" />
    <circle cx="7" cy="7" r="1.25" fill="currentColor" />
    <circle cx="11.5" cy="7" r="1.25" fill="currentColor" />
  </Svg>
);

export const Check = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
    <path d="M2.5 6.3l2.4 2.4 4.6-5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
);
