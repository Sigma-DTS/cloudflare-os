// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatPreset } from "@gadgets/workshop-shared/api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  listChatPresets: vi.fn<() => Promise<ChatPreset[]>>(),
}));

vi.mock("../../../AuthContext", () => {
  const context = { authenticatedApi: api };
  return { useAuthenticatedApi: () => context };
});

import { useChatPresets } from "./useChatPresets";

const DEEP: ChatPreset = { id: "deep", name: "Deep work", settings: { reasoning: "high" } };

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  api.listChatPresets.mockReset();
  vi.restoreAllMocks();
});

// The presets as the hook gives them, with a button that retries.
const Probe = () => {
  const { list, failed, retry } = useChatPresets();
  return (
    <>
      <p>{failed ? "failed" : list ? list.map((preset) => preset.name).join(", ") : "loading"}</p>
      <button type="button" onClick={retry}>Retry</button>
    </>
  );
};

const shows = () => document.querySelector("p")?.textContent;
const retry = () => act(async () => { document.querySelector("button")!.click(); });

describe("useChatPresets", () => {
  it("loads the presets again on retry once loading them failed, and not before", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    api.listChatPresets.mockRejectedValueOnce(new Error("Unavailable")).mockResolvedValue([DEEP]);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<Probe />));
    expect(shows()).toBe("failed");
    await retry();
    expect(shows()).toBe("Deep work");
    await retry();
    expect(api.listChatPresets).toHaveBeenCalledTimes(2);
  });
});
