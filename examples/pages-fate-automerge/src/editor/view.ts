/** The editor's only DOM file: a ProseMirror view kept in step with one open body. */
import { baseKeymap } from "prosemirror-commands";
import { history } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { Plugin } from "prosemirror-state";
import { Decoration, DecorationSet, EditorView } from "prosemirror-view";
import type { PageBody } from "../model/types.ts";
import { applyLocal, bodyState, remoteTransaction } from "./binding.ts";
import { pageKeymap, setLink, toggleTodo } from "./commands.ts";
import { pageInputRules } from "./rules.ts";

export type MountedEditor = {
  readonly view: EditorView;
  /** Answers `askHref`: links the selection, or with null only gives the editor its focus back. */
  link(href: string | null): void;
  destroy(): void;
};

export type EditorOptions = {
  /** A dispatch the body refused. The editor stays on the state that matches the body. */
  readonly onRefused: (error: unknown) => void;
  /** Mod-k on unlinked text, with where the selection ends on screen. The page answers through `link`. */
  readonly askHref: (at: { readonly left: number; readonly bottom: number }) => void;
};

const HINT = "Type # for a heading, - for a list, [] for a to-do";

/** A click on a todo's checkbox toggles it, and leaves the selection where it was. */
const todoCheckbox = new Plugin({
  props: {
    handleDOMEvents: {
      mousedown(view, event) {
        const check = (event.target as HTMLElement | null)?.closest?.(".todo > .check");
        if (!check || !view.editable) return false;
        event.preventDefault();
        const pos = view.posAtDOM(check.parentElement!, 0);
        return toggleTodo(view.state.doc.resolve(pos).before(1))(view.state, view.dispatch);
      },
    },
  },
});

/** An empty page shows a hint in its only block. */
const emptyHint = new Plugin({
  props: {
    decorations({ doc }) {
      const only = doc.firstChild!;
      if (doc.childCount > 1 || only.type.name !== "paragraph" || only.content.size > 0) return null;
      return DecorationSet.create(doc, [Decoration.node(0, only.nodeSize, { class: "hint", "data-hint": HINT })]);
    },
  },
});

export function mountEditor(place: HTMLElement, body: PageBody, options: EditorOptions): MountedEditor {
  const removed = () => body.save.read().state === "removed";
  const askHref = () => {
    const end = view.coordsAtPos(view.state.selection.to);
    options.askHref({ left: end.left, bottom: end.bottom });
  };
  const view: EditorView = new EditorView(place, {
    state: bodyState(body, [pageInputRules(), pageKeymap(askHref), keymap(baseKeymap), history(), todoCheckbox, emptyHint]),
    editable: () => !removed(),
    dispatchTransaction(tr) {
      try {
        view.updateState(applyLocal(body, view.state, tr));
      } catch (error) {
        options.onRefused(error);
      }
    },
  });
  const stopRemote = body.subscribe((edits) => view.dispatch(remoteTransaction(view.state, edits)));
  // Re-reads `editable` when the body turns removed.
  const stopSave = body.save.subscribe(() => view.setProps({}));
  return {
    view,
    link(href) {
      // The selection has been mapped through every edit since Mod-k, so it still covers the same text.
      if (href !== null) setLink(href)(view.state, view.dispatch);
      view.focus();
    },
    destroy() {
      stopRemote();
      stopSave();
      view.destroy();
    },
  };
}
