// The per-binding gatekeeper against a fake Graph, reached through TestHooks facets as the overseer
// reaches it: the binding pinned to its Entra user, its description and type at each access level,
// the folder boundary, the access units each read names for observers, and rejections that strand
// a temporary ID.

import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DriveEntry, SharePointScopeInfo } from "../../src/types";
import {
  BRIEF, DEEP, DRIVE, EMPTY, FakeGraph, NOTES, OTHER, OTHER_FILE, PHILLIP, READ_SCOPES, ROOT, SARAH, SITE_ID, SPECS,
  accountStub, facet, failure, folderProps, hooks, identityOf, props, ref, seedAccount, unwrap,
} from "./fake-graph";
import type { GatekeeperProps, Step } from "./worker";

afterEach(() => {
  vi.unstubAllGlobals();
});

const OUTSIDE = /is outside what this SharePoint connection covers, or doesn.t exist\./;

type Submitted = { actionId: number; description: { title: string } };

async function walk<T>(name: string, binding: GatekeeperProps, steps: Step[]): Promise<T[]> {
  return unwrap<T[][]>(await hooks().run(name, binding, steps, { pages: 10 })).flat();
}

describe("the binding", () => {
  it("pins the Entra user it was first used as, and refuses once the connection names another", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    const binding = folderProps(id);
    const name = facet("pin");
    unwrap(await hooks().run(name, binding, [["getScope"]]));

    await runInDurableObject(accountStub(id), async (_instance, state) => {
      state.storage.kv.put("identity", identityOf(SARAH));
    });
    hooks().restart(name);
    expect(failure(await hooks().run(name, binding, [["getScope"]])))
      .toMatch(/made for a different Microsoft 365 account than its connection now uses/);
    expect(failure(await hooks().applyAction(name, binding, 1))).toMatch(/different Microsoft 365 account/);
  });

  it("describes a folder binding by its place in the site", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    expect(unwrap(await hooks().describe(facet("describe"), folderProps(id)))).toEqual({
      url: "https://contoso.sharepoint.com/sites/Engineering/Shared%20Documents/Specs",
      title: "Specs",
      snippet: "Engineering › Documents › Specs",
      suggestedBindingName: "SHAREPOINT_FOLDER",
      tsType: "SharePointSession",
    });
  });

  it("describes everything by the account it reads as", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    expect(unwrap(await hooks().describe(facet("describe-all"), props(id, { kind: "all" })))).toMatchObject({
      title: "SharePoint & OneDrive", snippet: PHILLIP.upn, suggestedBindingName: "SHAREPOINT",
    });
  });

  it("still describes a binding whose folder is gone, so it can be removed", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    expect(unwrap(await hooks().describe(facet("gone"), folderProps(id, "01GONE00000000000000000000000000")))).toEqual({
      url: "",
      title: "Unavailable SharePoint item",
      snippet: "The folder this connection is for no longer exists, or you can no longer open it.",
      suggestedBindingName: "SHAREPOINT_FOLDER",
      tsType: "SharePointSession",
    });
  });

  it("keeps the last description it read when the folder later goes", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    const name = facet("gone-later");
    unwrap(await hooks().describe(name, folderProps(id)));
    graph.items.delete(SPECS);
    hooks().restart(name);
    expect(unwrap(await hooks().describe(name, folderProps(id)))).toMatchObject({ title: "Specs" });
  });
});

describe("read-only access", () => {
  it("follows a grant without write permissions: a reader, with nothing to approve", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph, PHILLIP, { scopes: READ_SCOPES });
    const binding = folderProps(id);
    const name = facet("read-only");
    expect(unwrap(await hooks().describe(name, binding))).toMatchObject({ tsType: "SharePointReader" });
    expect(unwrap<SharePointScopeInfo>(await hooks().run(name, binding, [["getScope"]])))
      .toMatchObject({ kind: "folder", can: { files: true, write: false } });
    // The session simply has no write methods.
    expect(failure(await hooks().run(name, binding, [["createFolder", ref(SPECS), "Drafts"]]))).toBeTruthy();
    expect((await hooks().queueLog(name)).submitted).toEqual([]);
    expect(unwrap(await hooks().autoApprovable(name, binding))).toEqual([]);
  });

  it("refuses a binding whose connection no longer grants SharePoint", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph, PHILLIP, { scopes: ["https://graph.microsoft.com/User.Read"] });
    expect(failure(await hooks().run(facet("no-sharepoint"), folderProps(id), [["getScope"]])))
      .toMatch(/no longer grants SharePoint access/);
  });

  it("offers for automatic approval only what each scope can submit, and never a delete", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    const files = ["sharepoint.files.create", "sharepoint.files.edit", "sharepoint.files.organize"];
    const cases: Array<[GatekeeperProps["scope"], string[]]> = [
      [{ kind: "all" }, [...files, "sharepoint.lists.edit"]],
      [{ kind: "site", siteId: SITE_ID }, [...files, "sharepoint.lists.edit"]],
      [{ kind: "library", siteId: SITE_ID, driveId: DRIVE }, files],
      [{ kind: "folder", siteId: SITE_ID, driveId: DRIVE, itemId: SPECS }, files],
      // The file is the binding's top: it can be replaced, not renamed or moved.
      [{ kind: "file", siteId: SITE_ID, driveId: DRIVE, itemId: NOTES }, ["sharepoint.files.edit"]],
      [{ kind: "list", siteId: SITE_ID, listId: "11111111-2222-3333-4444-555555555555" }, ["sharepoint.lists.edit"]],
      [{ kind: "page", siteId: SITE_ID, pageId: "11111111-2222-3333-4444-555555555555" }, []],
    ];
    for (const [scope, tags] of cases) {
      const kinds = unwrap<Array<{ tag: string }>>(await hooks().autoApprovable(facet(`auto-${scope.kind}`), props(id, scope)));
      expect(kinds.map(kind => kind.tag).toSorted(), scope.kind).toEqual(tags.toSorted());
    }
  });
});

describe("a folder binding", () => {
  it("lists from the folder, with paths measured from it", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    const binding = folderProps(id);
    const name = facet("folder-list");
    expect((await walk<DriveEntry>(name, binding, [["list"]])).map(entry => entry.path).toSorted())
      .toEqual(["Deep", "Empty", "brief.docx"]);
    expect((await walk<DriveEntry>(name, binding, [["list", { folderId: ref(DEEP) }]])).map(entry => entry.path))
      .toEqual(["Deep/notes.txt"]);
  });

  it("refuses everything whose ancestry leaves the folder, with one refusal for missing and outside alike", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    const binding = folderProps(id);
    const name = facet("folder-outside");
    expect(failure(await hooks().run(name, binding, [["getEntry", ref(OTHER_FILE)]]))).toMatch(OUTSIDE);
    expect(failure(await hooks().run(name, binding, [["list", { folderId: ref(OTHER) }]]))).toMatch(OUTSIDE);
    expect(failure(await hooks().run(name, binding, [["list", { folderId: `${DRIVE}/root` }]]))).toMatch(OUTSIDE);
    expect(failure(await hooks().run(name, binding, [["getEntry", ref(ROOT)]]))).toMatch(OUTSIDE);
    expect(failure(await hooks().run(name, binding, [["getEntry", ref("01NOSUCHITEM00000000000000000000")]]))).toMatch(OUTSIDE);
    expect(failure(await hooks().run(name, binding, [["getEntry", "b!AnotherLibraryEntirely0001/01X"]]))).toMatch(OUTSIDE);
    // Nothing outside was revealed, so nothing was observed.
    expect((await hooks().queueLog(name)).observations).toEqual([]);
  });

  it("refuses to change the folder it is for", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    expect(failure(await hooks().run(facet("folder-top"), folderProps(id), [["rename", ref(SPECS), "Renamed"]])))
      .toMatch(/top of what this connection covers/);
  });
});

describe("observations", () => {
  it("name the folder and every child a listing revealed", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    const sarah = await seedAccount(graph, SARAH);
    const binding = folderProps(id);
    const name = facet("units-listing");
    await walk(name, binding, [["list"]]);
    const [observation] = (await hooks().queueLog(name)).observations;
    expect(observation).toMatchObject({ title: "Listed a SharePoint folder" });
    expect(observation.description).toContain("brief\\.docx");

    unwrap(await hooks().addObserver(name, binding, "sarah", sarah));
    expect(graph.probedItems(SARAH).toSorted()).toEqual([SPECS, DEEP, EMPTY, BRIEF].toSorted());
  });

  it("refuse a collaborator who can't open one of the children", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    const sarah = await seedAccount(graph, SARAH);
    graph.hide(SARAH, BRIEF);
    const binding = folderProps(id);
    const name = facet("units-hidden");
    await walk(name, binding, [["list"]]);
    expect(failure(await hooks().addObserver(name, binding, "sarah", sarah)))
      .toMatch(/can't open something in SharePoint that this workspace has read/);
  });

  it("authorize an empty listing against the folder itself", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    const sarah = await seedAccount(graph, SARAH);
    const binding = folderProps(id);
    const name = facet("units-empty");
    expect(await walk(name, binding, [["list", { folderId: ref(EMPTY) }]])).toEqual([]);
    const [observation] = (await hooks().queueLog(name)).observations;
    expect(observation.description).toMatch(/Listed the folder Empty; it holds nothing more\./);
    unwrap(await hooks().addObserver(name, binding, "sarah", sarah));
    expect(graph.probedItems(SARAH)).toEqual([EMPTY]);
  });

  it("leave an admitted collaborator out of a later read they can't open", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    const sarah = await seedAccount(graph, SARAH);
    graph.hide(SARAH, NOTES);
    const binding = folderProps(id);
    const name = facet("units-exclude");
    unwrap(await hooks().run(name, binding, [["getScope"]]));
    unwrap(await hooks().addObserver(name, binding, "sarah", sarah));
    unwrap(await hooks().run(name, binding, [["getEntry", ref(NOTES)]]));
    const log = (await hooks().queueLog(name));
    expect(log.observations.at(-1)).toMatchObject({ title: "Read SharePoint file details", excludeObservers: ["sarah"] });
  });

  it("refuse a collaborator from another organization outright", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    const outsider = await seedAccount(graph, { ...SARAH, tid: "22222222-2222-2222-2222-222222222222" });
    const binding = folderProps(id);
    const name = facet("units-tenant");
    unwrap(await hooks().run(name, binding, [["getScope"]]));
    expect(failure(await hooks().addObserver(name, binding, "outsider", outsider))).toMatch(/different organization/);
  });
});

describe("rejecting", () => {
  it("restarts the gadget when a rejected folder is one a pending upload builds on", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    const binding = folderProps(id);
    const name = facet("reject");
    const folder = unwrap<DriveEntry>(await hooks().run(name, binding, [["createFolder", ref(SPECS), "Drafts"]]));
    expect(folder).toMatchObject({ id: expect.stringMatching(/^~/), path: "Drafts", pending: "create" });
    unwrap(await hooks().run(name, binding, [["uploadFile", folder.id, "plan.md", "# Plan\n"]]));
    unwrap(await hooks().run(name, binding, [["createFolder", ref(SPECS), "Unrelated"]]));
    const [create, , unrelated] = (await hooks().queueLog(name)).submitted as Submitted[];
    expect(create.description.title).toContain("Drafts");

    expect(unwrap(await hooks().rejectAction(name, binding, unrelated.actionId))).toBeUndefined();
    expect(unwrap(await hooks().rejectAction(name, binding, create.actionId))).toEqual({ restart: true });
    // The upload built on the rejected folder went with it.
    expect(await walk<DriveEntry>(name, binding, [["list"]])).not.toContainEqual(expect.objectContaining({ name: "Drafts" }));
  });

  it("refuses a name already taken in the folder, before anything is proposed", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    const name = facet("taken");
    expect(failure(await hooks().run(name, folderProps(id), [["createFolder", ref(SPECS), "Deep"]])))
      .toMatch(/already has something named "Deep"/);
    expect((await hooks().queueLog(name)).submitted).toEqual([]);
  });
});
