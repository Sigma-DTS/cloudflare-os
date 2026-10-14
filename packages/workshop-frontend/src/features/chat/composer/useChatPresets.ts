import { useEffect, useRef, useState } from "react";
import type { ChatPreset } from "@gadgets/workshop-shared/api";
import { useAuthenticatedApi } from "../../../AuthContext";
import { logRpcFailure } from "../../../rpcErrors";
import { sortChatPresets } from "./chatPresets";

/** The user's chat presets, and the writes that change them. */
export type ChatPresetsState = {
  /** The presets, ordered as the server lists them. Null until they load. */
  list: ChatPreset[] | null;
  /** Whether loading them failed. */
  failed: boolean;
  /** Adds `preset`, or replaces the one with its id. Rejects when the server refuses it. */
  save: (preset: ChatPreset) => Promise<void>;
  /** Deletes the preset with `id`. Rejects when the server fails to. */
  remove: (id: string) => Promise<void>;
  /** Loads the presets again if loading them failed. */
  retry: () => void;
};

/**
 * Loads the user's chat presets once, and again on `retry` after that fails. A write shows in the list at once, and the list is read
 * again once it settles, so a refused write leaves what the server holds.
 */
export const useChatPresets = (): ChatPresetsState => {
  const { authenticatedApi } = useAuthenticatedApi();
  const [list, setList] = useState<ChatPreset[] | null>(null);
  const [failed, setFailed] = useState(false);
  // A read's list is shown only while it is the latest read and no write is in flight, since a
  // read answered out of order, or before a write landed, would undo what the list shows.
  const reads = useRef(0);
  const writes = useRef(0);
  const mounted = useRef(true);

  const read = async () => {
    const attempt = ++reads.current;
    const current = () => mounted.current && attempt === reads.current && writes.current === 0;
    try {
      const presets = await authenticatedApi.listChatPresets();
      if (!current()) return;
      setList(presets);
      setFailed(false);
    } catch (err) {
      logRpcFailure("Failed to list chat presets:", err);
      if (current()) setFailed(true);
    }
  };

  useEffect(() => {
    mounted.current = true;
    void read();
    return () => {
      mounted.current = false;
    };
    // oxlint-disable-next-line exhaustive-deps -- loaded once per API connection.
  }, [authenticatedApi]);

  const write = async (change: (presets: ChatPreset[]) => ChatPreset[], send: () => Promise<void>) => {
    writes.current++;
    setList((presets) => presets && sortChatPresets(change(presets)));
    try {
      await send();
    } finally {
      writes.current--;
      void read();
    }
  };

  // A failed read after the list loaded leaves the list as it was.
  const loadFailed = failed && list === null;

  return {
    list,
    failed: loadFailed,
    save: (preset) => write(
      (presets) => [...presets.filter((other) => other.id !== preset.id), preset],
      () => authenticatedApi.saveChatPreset(preset),
    ),
    remove: (id) => write(
      (presets) => presets.filter((preset) => preset.id !== id),
      () => authenticatedApi.deleteChatPreset(id),
    ),
    retry: () => {
      if (!loadFailed) return;
      setFailed(false);
      void read();
    },
  };
};
