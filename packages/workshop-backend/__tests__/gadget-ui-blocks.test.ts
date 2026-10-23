import { describe, expect, it } from "vitest";
import { gadgetUiAnswerAsText, parseGadgetUiBlocks } from "@gadgets/workshop-shared/gadget-ui-blocks";

const lines = (...parts: string[]) => parts.join("\n");

describe("parseGadgetUiBlocks", () => {
  it("splits an answer into prose and blocks, in order, with each prose part's offset", () => {
    let answer = lines(
      "Food is up 18%.",
      '<gadget-ui gadget="EXPENSES">',
      "<title> Food, October </title>",
      "<div id=chart></div>",
      "</gadget-ui>",
      "Want weekly totals?",
    );
    expect(parseGadgetUiBlocks(answer)).toEqual([
      { kind: "text", text: "Food is up 18%.\n", start: 0 },
      { kind: "block", index: 0, gadget: "EXPENSES", title: "Food, October",
        html: "<title> Food, October </title>\n<div id=chart></div>" },
      { kind: "text", text: "\nWant weekly totals?", start: answer.indexOf("\nWant") },
    ]);
  });

  it("numbers every closed block, including one that must not run", () => {
    let segments = parseGadgetUiBlocks(lines(
      "<gadget-ui>", "a", "</gadget-ui>",
      "<gadget-ui gadget='no good'>", "b", "</gadget-ui>",
      "\t <gadget-ui gadget='APP'>", "c", "</gadget-ui>",
    ));
    expect(segments.flatMap(s => s.kind === "block" ? [[s.index, s.gadget, s.error !== undefined]] : []))
        .toEqual([[0, undefined, false], [1, undefined, true], [2, "APP", false]]);
  });

  it("binds only the gadget attribute itself, quoted or not", () => {
    let segments = parseGadgetUiBlocks(lines(
      "<gadget-ui gadget=EXPENSES>", "a", "</gadget-ui>",
      '<gadget-ui data-gadget="EXPENSES">', "b", "</gadget-ui>",
      '<gadget-ui class="wide" gadget = "APP">', "c", "</gadget-ui>",
    ));
    expect(segments.flatMap(s => s.kind === "block" ? [s.gadget] : []))
        .toEqual(["EXPENSES", undefined, "APP"]);
  });

  it("leaves a tag in a code fence or mid-line as prose", () => {
    let text = lines(
      "Write `<gadget-ui>` to draw a view:",
      "````html",
      "<gadget-ui>",
      "```",
      "</gadget-ui>",
      "````",
      "Done. <gadget-ui>not a block</gadget-ui>",
    );
    expect(parseGadgetUiBlocks(text)).toEqual([{ kind: "text", text, start: 0 }]);
  });

  it("closes a fence only on a bare marker of the same kind, at least as long", () => {
    let segments = parseGadgetUiBlocks(lines(
      "~~~~", "~~~", "```", "<gadget-ui>", "still code", "</gadget-ui>", "~~~~",
      "<gadget-ui>", "a view", "</gadget-ui>",
    ));
    expect(segments.map(s => s.kind)).toEqual(["text", "block"]);
  });

  it("closes a fence at most three spaces deeper than the line that opened it", () => {
    let segments = parseGadgetUiBlocks(lines(
      "1. Start it:", "    ```sh", "    npm start", "    ```",
      "<gadget-ui>", "a view", "</gadget-ui>",
      "```", "        ```", "<gadget-ui>", "still code", "</gadget-ui>", "```",
    ));
    expect(segments.map(s => s.kind)).toEqual(["text", "block", "text"]);
  });

  it("keeps an unclosed block open, with its title once streamed", () => {
    let streamed = lines("Here it comes:", "<gadget-ui>", "<title>Plan</title>", "<div>");
    expect(parseGadgetUiBlocks(streamed)).toEqual([
      { kind: "text", text: "Here it comes:\n", start: 0 },
      { kind: "open", text: "<gadget-ui>\n<title>Plan</title>\n<div>", title: "Plan" },
    ]);
    expect(parseGadgetUiBlocks("<gadget-ui>\n<ti")).toEqual([{ kind: "open", text: "<gadget-ui>\n<ti" }]);
  });

  it("reads a streamed answer the same at every cut once its blocks close", () => {
    let answer = lines("Intro.", "<gadget-ui>", "<p>one</p>", "</gadget-ui>", "Outro.");
    let final = parseGadgetUiBlocks(answer);
    for (let cut = 0; cut <= answer.length; cut++) {
      let blocks = parseGadgetUiBlocks(answer.slice(0, cut)).filter(s => s.kind === "block");
      expect(blocks).toEqual(cut >= answer.indexOf("</gadget-ui>") + "</gadget-ui>".length
          ? final.filter(s => s.kind === "block") : []);
    }
  });
});

describe("gadgetUiAnswerAsText", () => {
  it("puts a note that names each closed view in its place, and keeps an unclosed one", () => {
    let answer = lines(
      "Food is up 18%.", "<gadget-ui>", "<title>Food\n  by week</title>", "<script>draw()</script>",
      "</gadget-ui>", "<gadget-ui>", "<p>untitled</p>", "</gadget-ui>",
      "Want weekly totals?", "<gadget-ui>", "<div>",
    );
    expect(gadgetUiAnswerAsText(answer)).toBe(lines(
      "Food is up 18%.", "[View in the chat: Food by week]", "[View in the chat]",
      "Want weekly totals?", "<gadget-ui>", "<div>",
    ));
  });
});
