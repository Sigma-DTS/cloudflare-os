// Instance admin: an auto-provisioned gatekeeper whose account gives a deployment admin's agent the
// deployment's Admin API, as them. It holds no power of its own: the Workshop lends each session a
// grant that makes the calls and decides what each may do. README.md explains the design.

import { DurableObject, RpcStub, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type {
  AccountDescription,
  ActionKind,
  AgentCatalog,
  ApprovalQueue,
  Gatekeeper,
  GatekeeperConnectCallback,
  GatekeeperConnectOptions,
  GatekeeperUser,
  GatekeeperUserVerifier,
  GitCache,
  ResourceConfiguratorFrame,
  ResourceDescription,
  SupportedResource,
  VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { workerVersionTag } from "@gadgets/workshop-shared/gatekeeper";
import type {
  InstanceAdminGatekeeper as InstanceAdminGatekeeperContract, InstanceAdminGrant,
} from "@gadgets/workshop-shared/instance-admin";
import { InstanceAdminSession } from "./session.js";
import { adminDeclarations } from "./surface.js";

const SHIELD_ICON = {
  url:
    "data:image/svg+xml," +
    encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='currentColor'>" +
        "<path d='M208 40H48a16 16 0 0 0-16 16v56c0 52.72 25.52 84.67 46.93 102.19 23.06 18.86 46 25.27 47 25.53a8 8 0 0 0 4.2 0c1-.26 23.91-6.67 47-25.53C198.48 196.67 224 164.72 224 112V56a16 16 0 0 0-16-16Zm0 72c0 37.07-13.66 67.16-40.6 89.42A129.3 129.3 0 0 1 128 223.62a128.25 128.25 0 0 1-38.92-21.81C61.82 179.51 48 149.3 48 112V56h160Z'/></svg>",
    ),
};

const NO_RESOURCES = "The instance admin gatekeeper has no URL-addressed resources.";

/**
 * The workspace facet. The Workshop opens its sessions with startAdminSession() alone, lending each
 * a grant; it has no ApprovalQueue and no actions, so the generic entry points refuse.
 */
@validateRpc()
export class InstanceAdminGatekeeper
  extends DurableObject<Cloudflare.Env>
  implements InstanceAdminGatekeeperContract<InstanceAdminSession>
{
  /** Describes the ambient instance admin binding. */
  async describe(): Promise<ResourceDescription> {
    return {
      url: "instanceadmin://deployment",
      title: "Instance admin",
      snippet: "This deployment's Admin API, as the workspace's owner.",
      suggestedBindingName: "INSTANCE_ADMIN",
      tsType: "AdminApi",
    };
  }

  /** Returns the agent-facing AdminApi declarations, generated from the Admin API's schema. */
  async getTypeScriptTypes(): Promise<string> {
    return adminDeclarations();
  }

  /** Reports no actions: the Workshop queues and applies deployment admin actions itself. */
  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  /**
   * Opens a session that forwards every AdminApi call to `grant`.
   *
   * Skips validation, as GatekeeperVendor.createAccount() and InstanceAdminAccount.getVerifier()
   * do: capnweb-validate builds a method's return validator from its declared type, and
   * InstanceAdminSession's type declares none of its AdminApi methods (its static block defines
   * them at load), so a validated return would wrap the session in a proxy refusing every one of
   * them. The session checks each call's arguments against the schema, and the Workshop validates
   * them again, at its grant and at the Admin API. The skip also leaves `grant` unchecked, which only
   * the Workshop passes.
   */
  @skipRpcValidation()
  async startAdminSession(grant: RpcStub<InstanceAdminGrant>): Promise<InstanceAdminSession> {
    return new InstanceAdminSession(grant);
  }

  startSession(_approvalQueue: RpcStub<ApprovalQueue>): Promise<InstanceAdminSession> {
    throw new Error("The Workshop opens instance admin sessions with startAdminSession() only.");
  }

  /** Returns no catalog: the binding's types say everything there is to know. */
  async getAgentCatalog(): Promise<AgentCatalog | null> {
    return null;
  }

  addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    throw new Error("Nobody but this workspace's owner can see what the instance admin binding read.");
  }

  /** Removes a collaborator; none was ever admitted. */
  async removeObserver(_id: string): Promise<void> {}

  applyAction(_action: number, _cache: RpcStub<GitCache>): Promise<void> {
    throw new Error("The instance admin gatekeeper submits no actions: the Workshop applies " +
      "deployment admin actions itself.");
  }

  /** Accepts a rejection: there is no action state to clear. */
  async rejectAction(_action: number): Promise<void> {}

  revertAction(
    _action: number,
  ): Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
    throw new Error("The instance admin gatekeeper submits no actions, so it reverts none.");
  }
}

/**
 * An admin's account. It holds no credential and no state: the Workshop lends deployment admin power
 * per session, and offers the account only to current admins.
 */
@validateRpc()
export class InstanceAdminAccount extends WorkerEntrypoint<Cloudflare.Env> implements GatekeeperUser {
  /** Describes the account: an agent singleton and no management UI. */
  async describe(): Promise<AccountDescription> {
    return {
      displayName: "Instance admin",
      avatar: SHIELD_ICON,
      singleton: { tsType: "AdminApi" },
    };
  }

  /** Returns the workspace facet class. */
  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<InstanceAdminSession>>> {
    return this.ctx.exports.InstanceAdminGatekeeper({});
  }

  /** Returns no URL-addressed resources. */
  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }

  getGatekeeperClassFor(_url: string): never {
    throw new Error(NO_RESOURCES);
  }

  startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    throw new Error(NO_RESOURCES);
  }

  /** Confirms there are no resource scopes to grant. */
  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  /** Nothing to revoke: the account holds no credentials and no state. */
  async revoke(): Promise<void> {}

  reconnect(): Promise<{ url: string }> {
    throw new Error("The instance admin gatekeeper has no connect flow.");
  }

  commitReconnect(_stageId: string): Promise<void> {
    throw new Error("The instance admin gatekeeper has no connect flow.");
  }

  /** Returns no authentication identity. */
  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  /** Mints the trivial verifier; the facet admits no observer anyway. */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.InstanceAdminVerifier({});
  }
}

@validateRpc()
export class InstanceAdminVerifier
  extends WorkerEntrypoint<Cloudflare.Env>
  implements GatekeeperUserVerifier
{
  verify(): void {}
}

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> {
  /** Describes the auto-provisioned instance admin vendor. */
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Instance admin",
      url: "https://github.com/cloudflare/cloudflare-os/blob/main/docs/admin-access.md",
      logo: SHIELD_ICON,
      tagline: "Let your agent administer this deployment, as you",
      description: "Lets a deployment admin's agent use this deployment's Admin API as them, in a " +
        "workspace they turn it on in, which then stays theirs alone. Reads are recorded in that " +
        "workspace; every change, gateway test and content read waits for their approval. A prompt " +
        "injection can leak what the agent reads through the workspace's other connections, Web " +
        "Search included, its gadgets and the chat's AI model provider, so use a dedicated " +
        "workspace with as little else connected as you can. Offered to deployment admins only.",
      autoProvisionsAccount: true,
      providesAuth: false,
    };
  }

  /** The version tag of this Worker's running version, for the deployment's admins. */
  async versionTag(): Promise<string | undefined> {
    return workerVersionTag(this.env);
  }

  /** Mints a new account. All accounts are alike: none holds credentials or state. */
  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    return this.ctx.exports.InstanceAdminAccount({});
  }

  connectAccount(
    _callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    throw new Error("The instance admin gatekeeper is auto-provisioned and has no connect flow.");
  }

  /** Returns no URL-addressed resources, so agents are never offered it as one. */
  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    return [];
  }

  /** Returns the agent-facing AdminApi declarations. */
  async getTypeScriptTypes(): Promise<string> {
    return adminDeclarations();
  }
}

export default GatekeeperVendor;
