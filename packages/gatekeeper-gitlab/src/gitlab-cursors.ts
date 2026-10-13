// The streaming cursor shared by the GitLab gatekeeper's listings: the kit's `TokenCursor` keyed
// by GitLab's `nextPage`. In-memory listings use the kit's `ArrayCursor`, and each session's commit
// advertising the kit's `SessionGitCache`.

import { TokenCursor, type CursorInjection } from "@gadgets/gatekeeper-kit/cursors";
import type { Cursor } from "@gadgets/workshop-shared/gatekeeper";
import type { GitLabPage } from "./gitlab-api";

/** A page with each row mapped, keeping where the listing continues. */
export function mapPage<T, U>(page: GitLabPage<T>, map: (item: T) => U): GitLabPage<U> {
  return { items: page.items.map(map), nextPage: page.nextPage };
}

// GitLab sessions authorize each listing's observation up front, before the gatekeeper builds its
// cursor, so the cursor's per-page authorization has nothing left to do.
const authorizedUpFront = async () => {};

/**
 * Walks a GitLab listing page by page, merging `inject`ed simulated rows at their sort positions,
 * so a large listing never has to be fetched whole.
 */
export function gitlabCursor<T>(options: {
  /**
   * One page from GitLab (or the cache), overlaid and filtered. Its `nextPage`, not its length,
   * says whether the listing continues, so dropping rows is safe.
   */
  fetchPage(page: number, perPage: number): Promise<GitLabPage<T>>;
  inject?: CursorInjection<T>;
  pageSize: number;
}): Cursor<T> {
  return new TokenCursor<T>({
    pageSize: options.pageSize,
    fetchPage: async (token, perPage) => {
      const { items, nextPage } = await options.fetchPage(Number(token ?? 1), perPage);
      return { items, nextToken: nextPage === null ? undefined : String(nextPage) };
    },
    inject: options.inject,
    authorizePage: authorizedUpFront,
  });
}
