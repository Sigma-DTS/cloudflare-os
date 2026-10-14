import { useEffect, useState } from "react";
import type { ChatModelDescription } from "@gadgets/workshop-shared/api";
import type { OverseerSource } from "../../../components/chat/slash-command-catalog";
import { logRpcFailure } from "../../../rpcErrors";

/** What the composer knows of the selected model's chat settings. */
export type ChatModelDescriptionState = {
  /** The model's description. Null while it is being fetched, or when it could not be. */
  description: ChatModelDescription | null;
  /** Whether fetching it failed. */
  failed: boolean;
  /** Fetches the description again if fetching it failed. */
  retry: () => void;
};

/**
 * Describes the chat settings of `modelId` (null for none) through the workspace's overseer. An
 * answer for a model no longer selected is dropped. Nothing is fetched until `enabled`, so a
 * caller that would create a workspace to ask can wait until the settings are first opened.
 * After a failure it is fetched again on `retry`.
 */
export const useChatModelDescription = (
  getOverseer: OverseerSource,
  modelId: string | null,
  enabled = true,
): ChatModelDescriptionState => {
  const [answer, setAnswer] = useState<
    { modelId: string; attempt: number; description: ChatModelDescription | null } | null
  >(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (modelId === null || !enabled) return;
    let current = true;
    void (async () => {
      let description: ChatModelDescription | null = null;
      try {
        description = await (await getOverseer()).describeChatModel(modelId);
      } catch (err) {
        logRpcFailure("Failed to describe the chat model:", err);
      }
      if (current) setAnswer({ modelId, attempt, description });
    })();
    return () => {
      current = false;
    };
  }, [attempt, enabled, getOverseer, modelId]);

  // While a retry is pending the failed answer no longer stands, so the description is loading.
  const answered = modelId !== null && answer?.modelId === modelId && answer.attempt === attempt;
  const failed = answered && answer.description === null;
  return {
    description: answered ? answer.description : null,
    failed,
    retry: () => {
      if (failed) setAttempt((previous) => previous + 1);
    },
  };
};
