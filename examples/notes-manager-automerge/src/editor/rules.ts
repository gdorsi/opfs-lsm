import { InputRule, inputRules } from "prosemirror-inputrules";
import type { Plugin } from "prosemirror-state";
import type { Block, Depth } from "../model/types.ts";
import { blockOf, nodeTypeOf } from "./schema.ts";

type BlockRule = {
  readonly match: RegExp;
  readonly block: (current: Block) => Block;
};

const depthOf = (block: Block): Depth => ("depth" in block ? block.depth : 0);
const sameBlock = (a: Block, b: Block) =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([key, value]) => (b as Record<string, unknown>)[key] === value);

const BLOCK_RULES: readonly BlockRule[] = [
  { match: /^#\s$/, block: () => ({ type: "heading", level: 1 }) },
  { match: /^##\s$/, block: () => ({ type: "heading", level: 2 }) },
  { match: /^###\s$/, block: () => ({ type: "heading", level: 3 }) },
  { match: /^[-*]\s$/, block: (current) => ({ type: "item", list: "bullet", depth: depthOf(current) }) },
  { match: /^1\.\s$/, block: (current) => ({ type: "item", list: "number", depth: depthOf(current) }) },
  { match: /^\[ ?\]\s$/, block: (current) => ({ type: "todo", depth: depthOf(current), checked: false }) },
];

export function pageInputRules(): Plugin {
  return inputRules({
    rules: BLOCK_RULES.map(
      (rule) =>
        new InputRule(rule.match, (state, _match, start, end) => {
          const current = blockOf(state.doc.resolve(start).parent);
          const next = rule.block(current);
          if (sameBlock(next, current)) return null;
          const { type, attrs } = nodeTypeOf(next);
          return state.tr.delete(start, end).setBlockType(start, start, type, attrs);
        }),
    ),
  });
}
