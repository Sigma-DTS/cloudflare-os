// Views the agent's `executeCode` shows with `embedView` (see plans/embed-view.md). This module is
// the one place that turns a view into the HTML its frame runs, for the Workshop and the evals.

import type { EmbeddedView } from "./api";

/**
 * The view's HTML, as the body of a `<gadget-ui>` block: its style, its markup, then a module that
 * calls the view's script function with its data. The module goes in as a `data:` URL, so nothing
 * in the script's source or its data can end the script element or add markup.
 */
export function embeddedViewHtml(view: EmbeddedView): string {
  const style = view.css === undefined ? "" : `<style>${view.css}</style>\n`;
  if (view.script === undefined) return `${style}${view.html}`;
  const module = `await ${view.script}(${view.data ?? "null"});`;
  return `${style}${view.html}\n<script type="module" src="data:text/javascript;charset=utf-8,${encodeURIComponent(module)}"></script>`;
}
