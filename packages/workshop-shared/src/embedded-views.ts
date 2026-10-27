// Views the agent's `executeCode` shows with `embedView` (see plans/embed-view.md). This module is
// the one place that turns a view into the HTML its frame runs, for the Workshop and the evals.

import type { EmbeddedView } from "./api";

/**
 * The view's HTML, as the body of a `<gadget-ui>` block: its style, its markup, then one module
 * script that defines `data` and runs the view's code. The data goes in as a JSON string with each
 * `<` escaped, so text in it cannot end the script or add elements.
 */
export function embeddedViewHtml(view: EmbeddedView): string {
  const data = JSON.stringify(view.data ?? "null").replaceAll("<", "\\u003c");
  const style = view.css === undefined ? "" : `<style>${view.css}</style>\n`;
  return `${style}${view.html}\n<script type="module">\nconst data = JSON.parse(${data});\n${view.js ?? ""}\n</script>`;
}
