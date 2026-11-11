import { PRIORITY_LABELS, STATUS_LABELS, type PriorityCode, type StatusCode } from "../domain/model.ts";
import { PriorityIcon, StatusIcon } from "./icons.tsx";
import { item, MenuButton } from "./menu.tsx";

const CODES = [0, 1, 2, 3, 4] as const;

interface PickerProps<T> {
  readonly value: T;
  onPick(next: T): void;
  /** `icon` is the bare icon button of a row; `field` adds the label. */
  readonly variant: "icon" | "field" | "pill";
}

export function StatusPicker({ value, onPick, variant }: PickerProps<StatusCode>) {
  const entries = CODES.map((c: StatusCode) => item(`s${c}`, STATUS_LABELS[c], () => onPick(c), { icon: <StatusIcon status={c} />, checked: c === value }));
  return (
    <MenuButton className={variant === "icon" ? "icon-btn" : variant === "pill" ? "pill" : "menu-btn"} entries={entries} title={`Status: ${STATUS_LABELS[value]}`}>
      <StatusIcon status={value} />
      {variant !== "icon" && STATUS_LABELS[value]}
    </MenuButton>
  );
}

export function PriorityPicker({ value, onPick, variant }: PickerProps<PriorityCode>) {
  const entries = CODES.map((c: PriorityCode) => item(`p${c}`, PRIORITY_LABELS[c], () => onPick(c), { icon: <PriorityIcon priority={c} />, checked: c === value }));
  return (
    <MenuButton className={variant === "icon" ? "icon-btn" : variant === "pill" ? "pill" : "menu-btn"} entries={entries} title={`Priority: ${PRIORITY_LABELS[value]}`}>
      <PriorityIcon priority={value} />
      {variant !== "icon" && PRIORITY_LABELS[value]}
    </MenuButton>
  );
}
