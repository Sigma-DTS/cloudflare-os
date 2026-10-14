// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatModelSettings } from "@gadgets/workshop-shared/api";
import type { ChatSettingsControl } from "./features/chat/composer/ComposerChatSettings";

// The Home composer's model settings, as they reach the chat it starts. The test sits beside
// homePromptFlow.test.tsx rather than in routes/, where the router would take it for a route.

type ComposerProps = {
  chatSettings: ChatSettingsControl;
  onSend: (message: string, modelId: string | null) => Promise<void>;
};

const testState = vi.hoisted(() => {
  const overseer = {
    newChat: vi.fn<(...args: unknown[]) => Promise<number>>(async () => 7),
    getMetadata: vi.fn<() => Promise<{ id: string }>>(async () => ({ id: "workspace" })),
    [Symbol.dispose]: vi.fn<() => void>(),
  };
  return {
    overseer,
    authenticatedApi: {
      listModels: vi.fn<() => Promise<unknown[]>>(async () => [
        { type: "agent", id: "model", name: "Model" },
      ]),
      listChatPresets: vi.fn<() => Promise<never[]>>(async () => []),
      newGadget: vi.fn<() => typeof overseer>(() => overseer),
    },
    navigate: vi.fn<(options: unknown) => void>(),
    composer: { props: undefined as ComposerProps | undefined },
  };
});

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => testState.navigate,
}));

vi.mock("@cloudflare/kumo", () => ({
  useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
}));

vi.mock("./AuthContext", () => ({
  useAuthenticatedApi: () => ({
    authenticatedApi: testState.authenticatedApi,
    currentUser: { id: "user-a", name: "User A" },
  }),
}));

vi.mock("./features/chat/composer/ChatComposer", () => ({
  ChatComposer: (props: ComposerProps) => {
    testState.composer.props = props;
    return null;
  },
}));

vi.mock("./components/MeshBackground", () => ({ default: () => null }));
vi.mock("./components/AppShell/HomeTaskSuggestions", () => ({ default: () => null }));
vi.mock("./useDocumentTitle", () => ({ useDocumentTitle: () => {} }));

import { HomePageContent } from "./routes/index";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const composer = () => {
  const props = testState.composer.props;
  if (!props) throw new Error("No composer");
  return props;
};

const storedSettings = (): unknown =>
  JSON.parse(localStorage.getItem("lastChatModelSettings") ?? "null");

describe("Home composer chat settings", () => {
  let root: Root | undefined;

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = undefined;
    localStorage.clear();
    testState.composer.props = undefined;
    vi.clearAllMocks();
  });

  const renderHome = async () => {
    root = createRoot(document.createElement("div"));
    await act(async () => root!.render(<HomePageContent />));
  };

  it("starts with the settings last used, and remembers a change", async () => {
    localStorage.setItem("lastChatModelSettings", JSON.stringify({ compactionInputBudget: 300_000 }));
    await renderHome();
    expect(composer().chatSettings.settings).toEqual({ compactionInputBudget: 300_000 });

    const settings: ChatModelSettings = { reasoning: "high" };
    await act(async () => composer().chatSettings.onSettingsChange(settings));
    expect(storedSettings()).toEqual({ reasoning: "high" });
    expect(composer().chatSettings.settings).toEqual({ reasoning: "high" });

    await act(async () => composer().chatSettings.onSettingsChange({}));
    expect(storedSettings()).toBeNull();
  });

  it("starts the new chat with the composer's settings", async () => {
    await renderHome();
    await act(async () => composer().chatSettings.onSettingsChange({ reasoning: "high" }));
    await act(async () => composer().onSend("Build a dashboard", "model"));
    expect(testState.overseer.newChat).toHaveBeenCalledExactlyOnceWith(
      "Build a dashboard", "model", undefined, undefined, undefined, { reasoning: "high" });
    expect(testState.navigate).toHaveBeenCalledWith(
      { to: "/workspace/$id", params: { id: "workspace" }, search: { chat: 7 } });
  });

  it("sends no settings for a chat that sets none", async () => {
    await renderHome();
    await act(async () => composer().onSend("Build a dashboard", "model"));
    expect(testState.overseer.newChat).toHaveBeenCalledExactlyOnceWith(
      "Build a dashboard", "model", undefined, undefined, undefined, undefined);
  });
});
