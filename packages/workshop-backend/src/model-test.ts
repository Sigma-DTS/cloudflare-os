import type { AiModelConfig, GatewayModelLevelTest, GatewayModelTest, ReasoningLevel } from "@gadgets/workshop-shared/api";
import type { AiGatewayConfig } from "./ai-gateway.js";
import { AgentTurnError, completeText } from "./ai-invoke.js";
import { getModel, type UserGatewayRouting } from "./ai-models.js";
import type { createWorkshopLogger } from "./observability";

/**
 * A test of a model through the gateway: the logger, event and message of its log line, the
 * response cap of its request (the model's own, where that is lower), whether the request asks
 * for what an agent's turn would (see completeText), and how long the model has to answer.
 */
export type GatewayTest = {
  logger: ReturnType<typeof createWorkshopLogger>, event: string, logged: string,
  maxTokens: number, thinking: boolean, timeoutMs: number,
};

/** How a test sends a model the request one of its chat turns would. */
export const MODEL_TEST_REQUEST = { maxTokens: 2048, thinking: true, timeoutMs: 30_000 };

// What a failed test tells its caller: the provider's or the gateway's own words with the
// deployment's gateway token cut out, should they repeat it, on one line and cut short.
function testFailureMessage(text: string, apiToken: string | undefined): string {
  if (apiToken) text = text.replaceAll(apiToken, "[redacted]");
  return text.replace(/\s+/g, " ").trim().slice(0, 300);
}

/**
 * Send the model `config` describes one prompt through the gateway, as `test` says to and on
 * behalf of the user `initiator`, and report what happened. A request that fails is a result.
 * `userGateway` routes the request through the user's own gateway instead, billing them.
 */
export async function runModelTest(
    env: Cloudflare.Env, gateway: AiGatewayConfig, config: AiModelConfig, initiator: string,
    test: GatewayTest, userGateway?: UserGatewayRouting): Promise<GatewayModelTest> {
  let model = config.model;
  let signal = AbortSignal.timeout(test.timeoutMs);
  let startedAt = Date.now();
  let failure: { status?: number, message: string } | undefined;
  try {
    let handle = getModel(env, config, { type: "user", id: initiator, name: initiator },
        { userGateway });
    await completeText(handle, {
      prompt: "Reply with OK.", maxTokens: Math.min(test.maxTokens, handle.model.maxTokens),
      thinking: test.thinking, signal,
      // Agent turns let the provider cache their prompts, so a model that rejects the cache
      // fields fails here rather than in the first turn.
      cache: true,
      // The request is the same every time, which a gateway that caches responses would
      // answer without asking the provider.
      headers: { "cf-aig-skip-cache": "true" },
    });
  } catch (error) {
    // The signal is this call's own, so nothing but the timeout aborts it.
    let message = signal.aborted
        ? `The model did not answer within ${test.timeoutMs / 1000} seconds.`
        : error instanceof Error ? error.message : String(error);
    let status = error instanceof AgentTurnError ? error.statusCode : undefined;
    failure = {
      ...(status !== undefined && { status }),
      message: testFailureMessage(message, gateway.apiToken),
    };
  }
  // The failure message stays out of the log: a provider words it.
  test.logger.info(test.logged, {
    event: test.event, modelId: model, outcome: failure ? "error" : "ok",
    statusCode: failure?.status, durationMs: Date.now() - startedAt,
  });
  return failure ? { model, ok: false, ...failure } : { model, ok: true };
}

/**
 * Test a model with one request that sets no level of the test's own and one at each of
 * `levels`, all sent together through runModelTest(). `configAt` gives the config each request
 * goes out with. The results come in that order, each with its level, which is null for the
 * request that set none.
 */
export function runLevelTests(
    env: Cloudflare.Env, gateway: AiGatewayConfig,
    configAt: (reasoning: ReasoningLevel | null) => AiModelConfig, levels: ReasoningLevel[],
    initiator: string, test: GatewayTest, userGateway?: UserGatewayRouting)
    : Promise<GatewayModelLevelTest[]> {
  return Promise.all([null, ...levels].map(async reasoning => ({
    ...await runModelTest(env, gateway, configAt(reasoning), initiator, test, userGateway),
    reasoning,
  })));
}
