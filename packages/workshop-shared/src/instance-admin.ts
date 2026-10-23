// The instance admin Gatekeeper's contract with the Workshop. It is the one Gatekeeper that serves
// its admin's agent the deployment's Admin API, and it is given no power of its own to do so: the
// Workshop lends it, one session at a time, a capability that makes the Admin API's calls itself and
// keeps every decision about them (whether a call runs, waits for the admin's approval or is refused;
// what the approval card says; what is recorded) on the Workshop's side. Like cloudflare-gatekeeper.ts
// it extends the generic contract with what only the Workshop calls, so nothing generic carries it.

import type { RpcStub, RpcTarget } from "cloudflare:workers";
import type { Gatekeeper } from "./gatekeeper.js";

/**
 * The vendor id of the instance admin Gatekeeper: the Gatekeeper bound as GATEKEEPER_INSTANCEADMIN,
 * which is packages/gatekeeper-instanceadmin in every environment. A dev server, a release and the
 * integration harness all derive this id from that binding, and the release build refuses any other
 * package whose install slug folds to it. The Workshop lends deployment admin power to whatever Worker
 * answers to the binding, so the binding is trusted as the backend's own configuration is.
 */
export const INSTANCE_ADMIN_VENDOR_ID = "instanceadmin";

/**
 * How long a call approved one at a time (InstanceAdminCallResult "needsApproval" for "confirm" or
 * "inspect") stays available, in seconds from the approval: the agent's next identical call in the
 * same chat within it runs once.
 */
export const INSTANCE_ADMIN_APPROVAL_LIFETIME_SECONDS = 900;

/**
 * How long one executeCode call can use the instance admin binding, in seconds from the call's start.
 * After it the Workshop refuses the grants minted for that call and the views the call opened, and the
 * agent makes further calls from a new executeCode call. It bounds how long a run that was handed the
 * binding, and whatever the run passed the binding to, can act as the admin.
 */
export const INSTANCE_ADMIN_RUN_LIMIT_SECONDS = 600;

/** What InstanceAdminGrant.callAdminApi() did with a call. */
export type InstanceAdminCallResult =
  /** The call ran: `value` is its result, plain data, or for inspectWorkspace() an AdminWorkspaceView
   * that works only while the code run that opened it can use the binding. */
  | { outcome: "answered"; value: unknown }
  /** A change (an AdminApi method tagged `@mutates`), queued as action `actionId` for the admin's
   * approval. Nothing changed: the Workshop makes exactly this call if and when they approve. */
  | { outcome: "queued"; actionId: number }
  /** Nothing ran. Action `actionId` asks the admin to approve: turning deployment admin access on
   * in this workspace ("activate"), or this one call ("confirm" for a method tagged `@confirmation`,
   * "inspect" for inspectWorkspace() asking for "full"), which then runs once, as the agent's next
   * identical call in the same chat within INSTANCE_ADMIN_APPROVAL_LIFETIME_SECONDS. `existing` when
   * this turn already made an identical request: no new action was made, and the turn waits on that
   * one. */
  | { outcome: "needsApproval"; actionId: number; existing: boolean;
      reason: "activate" | "confirm" | "inspect" };

/**
 * The deployment admin power the Workshop lends the instance admin Gatekeeper: the Admin API of the
 * workspace's owner, for the agent's executeCode run a session was opened in. The Workshop mints one
 * for each session, through InstanceAdminGatekeeper.startAdminSession(), and each works only for that
 * run, while it runs: until the run's code settles, the owner stops the turn, or
 * INSTANCE_ADMIN_RUN_LIMIT_SECONDS pass since the run started. Every call re-checks, before it runs and
 * again before it answers, that the run is still live; that its turn answers a message the owner
 * wrote themselves (not the text a connection's slash command expanded to, which the chat logs as
 * theirs), in a chat that is neither spawned nor a blueprint update's review; that the owner is still
 * a deployment admin; that the deployment still offers this Gatekeeper; and that deployment admin
 * access is on in the workspace. Once any of that stops being true it refuses everything, so there is
 * nothing to gain by keeping it.
 */
export interface InstanceAdminGrant extends RpcTarget {
  /**
   * Calls AdminApi's `method` with `args` as the Workshop's ADMIN_AGENT_ACCESS says it may: a read runs
   * at once and is recorded in the workspace's activity before it answers; a change is queued for the
   * owner's approval; a call needing approval one at a time runs only as the agent's identical call
   * after an approval, and is recorded in the workspace's activity as soon as it has run, whether it
   * returned or threw; a withheld method, or a name that is not an AdminApi method, is refused. While
   * deployment admin access is off in the workspace, every call naming an available method with
   * well-formed arguments asks the owner to turn it on instead. Throws what the Admin API throws, and
   * TypeError for malformed arguments.
   */
  callAdminApi(method: string, args: unknown[]): Promise<InstanceAdminCallResult>;
}

/**
 * The instance admin Gatekeeper's facet (INSTANCE_ADMIN_VENDOR_ID). The Workshop opens its sessions
 * with startAdminSession() and never calls startSession(), applyAction() or rejectAction() on it: it
 * has no ApprovalQueue and submits no actions of its own (the Workshop queues and applies the Admin
 * API's).
 */
export interface InstanceAdminGatekeeper<Session> extends Gatekeeper<Session> {
  /**
   * Opens a session for one call from an agent's executeCode run, given `grant`, which the Workshop
   * mints for this session and which works only for that run (see InstanceAdminGrant). The session
   * serves AdminApi as this Gatekeeper's getTypeScriptTypes() declares it, each method a call to
   * `grant`. Keep nothing derived from `grant` beyond the session.
   */
  startAdminSession(grant: RpcStub<InstanceAdminGrant>): Promise<Session>;
}
