# `@gadgets/api-schema`

The schema of the Workshop API, and the generic tools that make and read it. The API is the
[Cap'n Web](https://github.com/cloudflare/capnweb) capability graph declared in
`packages/workshop-shared/src/api.ts`, and Cap'n Web has no schema of its own, so this package
extracts one from the TypeScript: every capability interface reachable from `PublicApi`, with
each method's parameters, awaited result and doc comment, and the named types they use. Everything
that describes the API to a client or an agent is generated from that one JSON file, without
reading TypeScript itself.

This is the interim home of the format, called capnweb-schema. The proposal for where it goes
next is [`plans/capnweb-api-schema.md`](../../plans/capnweb-api-schema.md).

## The format

`src/schema.ts` is the specification: a `Schema` starts with its `format`, `"capnweb-schema/0"`,
so a reader can refuse a format it does not know, names its `entry` interface, records its byte
`constants`, and holds `services` (each capability interface, server- and client-implemented
alike, with its methods and properties) and `shapes` (named object and union types, which other
shapes refer to by name, so a recursive type stays finite). Shapes follow capnweb-validate's own
classification of types, and a capability is a `stub` naming the service it continues on.
Services, shapes, methods, properties and union branches are sorted, so the same declarations
always serialize to the same bytes; method and function parameters and tuple elements keep their
declared order, which is what positional arguments mean.

Beyond names, types and docs, the schema records:

- each service's `direction`: `"server"` for a capability the caller receives, `"client"` for one
  it implements and passes (a subscriber, a callback), `"both"` for one reached each way;
- a service's `properties`, its non-method members, which a stub reads by pipelining
  (`stub.foo.bar()`);
- a stream's `element`, what a `ReadableStream<T>` or `WritableStream<T>` carries;
- `deprecated`, from a `@deprecated` tag, on a service, method or property;
- `mutates: true` on a method whose doc has a `@mutates` tag, so a Gatekeeper can route it through
  approval;
- `confirmation` on a method whose doc has a `@confirmation` tag: the tag's text (`""` when bare),
  the sentence a host shows before a call that costs or commits something even though it changes
  no state, so a Gatekeeper can route that through approval too.

In the Workshop API, `AdminApi`'s setters carry `@mutates` and its gateway tests, which send
requests the deployment's AI providers bill, `@confirmation`.

Each of these but `direction` is omitted when absent, and none changes what an existing field
means, so a reader that predates them can ignore them.

## Generated files

`generated/` is committed. Nothing in it is edited by hand.

The last column is who each is for. `pnpm cf-os api` renders its command table from
`workshop-api.schema.json` and copies the agent declarations; the instance admin Gatekeeper reads
`admin-api.schema.json`, and the Workshop's and the Gatekeeper's tests check the Admin API's tags and
the admin subset against `workshop-api.schema.json`; nothing reads the other files yet.

| File | What it is | Meant for |
| --- | --- | --- |
| `workshop-api.schema.json` | The capnweb-schema of everything reachable from `PublicApi`. | `pnpm cf-os api` ([`packages/api-cli`](../api-cli/README.md)), whose command table, `packages/api-cli/generated/commands.ts`, `pnpm api-schema:generate` renders from it in the same step, reading its services' methods, not their properties. [cloudflare-os-starter](https://github.com/cloudflare/cloudflare-os-starter)'s `cf-os api` is to run that CLI from its submodule, in place of its own copy. |
| `workshop-api.agent.d.ts` | One self-contained declaration file of what a holder of an `AuthenticatedApi` stub can call, without the credential methods (`authenticate`, `login`, `changePassword`, ...). | Gatekeepers and code-mode agents, to write code against. The agent's `describeBinding` still writes its own description. |
| `workshop-api.fragments.json` | The same declarations split per service, each fragment readable on its own, other services referred to by name. | Agents that fetch one service at a time instead of the whole surface. Shaped like the answer a live introspection method would give ([capnweb#177](https://github.com/cloudflare/capnweb/issues/177)), but rendered from `AuthenticatedApi`'s point of view, so a shape's name or position can differ from what one stub alone would report, and without the credential methods, which such a method would list unless it left them out too. |
| `workshop-api.tools.json` | **Experimental.** One tool per method callable from `AuthenticatedApi`, each with a JSON Schema for its arguments and result, `continuesOn` where the result is a capability, and the method's `deprecated`, `mutates` and `confirmation` where it has them. | A base for MCP and tool search; its shape may change. |
| `admin-api.schema.json` | The capnweb-schema of what a holder of an `AdminApi` stub reaches (`subsetSchema`), without the methods the instance admin Gatekeeper withholds (`ADMIN_OMIT`): `AdminApi` and the `AdminWorkspaceView` it opens. | `packages/gatekeeper-instanceadmin`, which bundles it, renders its agent's declarations from it with the same emitter, and checks each call's arguments against it with `checkArguments`. |
| `admin-api.agent.d.ts` | That schema's declarations, rooted at `AdminApi`: what the Gatekeeper's `getTypeScriptTypes()` renders, under its own header. | Reviewers: the Gatekeeper's agent-facing types, read as another Gatekeeper's `types.d.ts` is. |
| `admin-api.fragments.json` | The same declarations split per service. | As `workshop-api.fragments.json`. |

The declarations use the web platform's globals (`ReadableStream`), as a Worker has them, and
`Symbol.dispose` (TypeScript's `esnext.disposable` lib): every stub the agent holds can be disposed,
which is how it cancels a subscription. A call returning a capability returns it as
`Pipelined<Service>`, which can be called on before it resolves (`api.openGadget(id).listChats()`).
A value parameter is `Awaitable<T>`, the value or a promise of it, so one call's result is passed
to the next without awaiting it (`gadget.setTitle(other.getTitle())`), and a subscriber's methods
return `Awaitable<T>`, so an implementation may return its result as is or be `async`. A
service's property is a `readonly` member, which a holder reads as it would a method's result,
and `@deprecated`, `@mutates` and `@confirmation` appear in the JSDoc.

## Regenerating

After changing `packages/workshop-shared/src/api.ts`, run:

```sh
pnpm api-schema:generate
```

and commit the regenerated files with the change. It also rewrites `packages/api-cli/generated/`,
`pnpm cf-os api`'s command table and its copy of the agent declarations. `pnpm api-schema:check`,
part of `pnpm lint` and CI, writes nothing and fails naming any file that is out of date, those
included. Both print `{"files": [...]}` on stdout, the files written or stale; everything else goes
to stderr.

## What is generic, and what is not

`src/` knows nothing about this repository, so it can move unchanged:

- `src/schema.ts` and `src/extract.ts` (the format and the extractor) are meant for capnweb, next
  to capnweb-validate, whose type rules the extractor follows. The extractor imports only
  `typescript6` (TypeScript 7 ships no JavaScript compiler API) and `node:path`, and takes the
  entry file, its tsconfig, the entry interface and the constants as options. It recognises Cap'n
  Web's and the Workers runtime's own declarations by install path, or by an `isRuntimeFile`
  option for a linked or vendored copy.
- `src/emit/dts.ts` and `src/emit/tools.ts` are pure functions of a `Schema` and their options (a
  root service, the methods to omit): no `node:` imports, file system, clock, randomness or
  environment, and deterministic output. That is the core of a
  [forge](https://github.com/cloudflare/forge) plugin, which is where they are meant to go. The
  port still has to name the files (done in `scripts/generate.ts` today), supply the options,
  which a forge plugin has no input for yet, and hand them a `Schema`: a forge plugin reads
  forge's IR, not capnweb-schema, so either an adapter rebuilds the schema from the IR or forge
  passes the document through to plugins (the RFC's §6).
- `src/subset.ts` and `src/check.ts` are pure in the same way. `subsetSchema` cuts a schema down to
  what a holder of one service's stub reaches, less the methods omitted: emitting declarations from
  it gives what emitting them from the whole schema with the same omissions gives. `checkArguments`
  says what is wrong with one call's arguments, one line per problem
  (`options.limit: expected number`), checking values only: a capability, function or stream is
  always a problem. Both are for a host that serves one capability from its schema alone, as the
  instance admin Gatekeeper does: `scripts/generate.ts` cuts the admin schema with `subsetSchema`,
  and the Gatekeeper bundles `src/check.ts`, with `src/schema.ts` and `src/emit/dts.ts`, into its
  Worker.

`scripts/generate.ts` is the only product-specific file: it names `api.ts` and its tsconfig, the
entry `PublicApi`, the constant `SERVICE_SALT`, the agent root `AuthenticatedApi` and the
credential methods an agent never calls, the instance admin Gatekeeper's root `ADMIN_ROOT`
(`AdminApi`) and the methods it withholds, `ADMIN_OMIT`. It also renders the CLI's files, through
`packages/api-cli/generator/emit.ts`, and it is the only part that writes to disk.
