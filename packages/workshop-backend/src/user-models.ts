import type { AiModelConfig, GatewayModelLevelTest, ModelDescription, RedactedAiModelConfig } from "@gadgets/workshop-shared/api";
import { sanitizeCapabilities } from "./admin-config.js";
import { compactionBudgetRange } from "./agent-compaction.js";
import { checkUsageAndBalance } from "./ai-gateway-billing/limits/usage-checker.js";
import type { GatewayModels } from "./ai-gateway.js";
import { describeGatewayModel } from "./ai-models.js";
import { MODEL_TEST_REQUEST, runLevelTests, type GatewayTest } from "./model-test.js";
import { createWorkshopLogger } from "./observability";
import type { UserDurableObject } from "./user.js";

const logger = createWorkshopLogger("workshop.user.models");

// A test a user runs of a model they describe (see AuthenticatedApi.testModel).
const USER_MODEL_TEST: GatewayTest = {
  logger, event: "user.model.test", logged: "tested a model a user described",
  ...MODEL_TEST_REQUEST,
};

/**
 * The config a model a user describes as `config` is kept with: throws unless its provider may be
 * used on the deployment `models` describes and its token limits and compaction budget are in
 * range, and leaves out `behavesLike`, which only a deployment's admin sets. Adding, editing,
 * describing and testing a model all go through here, so that a test is held to what adding the
 * model would be.
 */
export function userModelConfig(config: AiModelConfig, models: GatewayModels | null): AiModelConfig {
  if (models && !models.providers.has(config.provider)) {
    throw new Error(`Provider "${config.provider}" is not available in AI Gateway mode.`);
  }
  for (let limit of [config.contextWindow, config.outputLimit]) {
    if (limit !== undefined && !(Number.isSafeInteger(limit) && limit > 0)) {
      throw new Error("Token limits must be positive integers.");
    }
  }

  // capnweb-validate lets through properties that RedactedAiModelConfig omits.
  let {behavesLike, capabilities, ...own} = config;
  let stated = sanitizeCapabilities(capabilities);
  let result: AiModelConfig = {...own, ...(stated && {capabilities: stated})};

  let budget = result.compactionInputBudget;
  if (budget !== undefined) {
    let {max} = compactionBudgetRange(result);
    if (max <= 0) {
      throw new Error("The model's context window leaves no room for a compaction budget.");
    }
    if (!Number.isSafeInteger(budget) || budget <= 0 || budget > max) {
      throw new Error(`The compaction budget must be a whole number of tokens from 1 to ${max}.`);
    }
  }
  return result;
}

// The deployment's gateway models. Throws outside AI Gateway mode, the only one in which a user's
// model is described or tested.
function requireGateway(models: GatewayModels | null): GatewayModels {
  if (!models) throw new Error("This deployment does not provide models through AI Gateway.");
  return models;
}

// The model a user describes as `config` on the gateway deployment `models` describes, as it
// would be kept, with its secrets dropped: AI Gateway mode sends none of them.
function describedConfig(config: RedactedAiModelConfig, models: GatewayModels): AiModelConfig {
  let {apiToken, extraHeaders, ...rest} = config;
  return userModelConfig({...rest, apiToken: ""}, models);
}

/** AuthenticatedApi.describeModel(), on the deployment `models` describes. */
export function describeUserModel(models: GatewayModels | null, config: RedactedAiModelConfig)
    : ModelDescription {
  return describeGatewayModel(describedConfig(config, requireGateway(models)));
}

/**
 * AuthenticatedApi.testModel(), on the deployment `models` describes, for the user `userId`
 * whose object is `user`. The test is counted as one chat turn, and billed to the user's own
 * gateway when a chat turn would be.
 */
export async function testUserModel(
    env: Cloudflare.Env, models: GatewayModels | null, config: RedactedAiModelConfig,
    userId: string, user: DurableObjectStub<UserDurableObject>)
    : Promise<GatewayModelLevelTest[]> {
  let deployment = requireGateway(models);
  deployment.refuseUserModel();
  let own = describedConfig(config, deployment);
  let usage = await checkUsageAndBalance(env, user);
  if (!usage.allowed) throw new Error(usage.reason ?? "Usage limit reached.");
  return runLevelTests(env, deployment.gateway,
      // The request with no level of the test's own goes out as a chat turn on the model would.
      reasoning => reasoning === null ? deployment.userRunConfig(own) : { ...own, reasoning },
      describeGatewayModel(own).reasoningLevels, userId, USER_MODEL_TEST,
      usage.shouldUseByok ? usage.byokRouting : undefined);
}
