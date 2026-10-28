import { RpcStub } from "cloudflare:workers";
import { expect, it } from "vitest";
import { GitCacheImpl, WorkspaceGitCache } from "../../../workshop-backend/src/git-cache";

it("projects the real native cache binding for session and action capabilities, including zero", async () => {
  // No Git objects are read: this isolates the new metadata projection from storage/provider I/O.
  const cache = Object.create(WorkspaceGitCache.prototype) as WorkspaceGitCache;
  using session = new RpcStub(new GitCacheImpl(cache, 0));
  using action = new RpcStub(new GitCacheImpl(cache, 0, 101));
  using other = new RpcStub(new GitCacheImpl(cache, 1));
  expect(await session.getBindingId()).toBe(0);
  expect(await action.getBindingId()).toBe(await session.getBindingId());
  expect(await other.getBindingId()).not.toBe(await session.getBindingId());
});
