// The subset of a schema that a holder of one service's stub reaches: what a host that serves only
// that service (a Gatekeeper that hands an agent one capability) bundles instead of the whole API,
// to render its declarations from and check its calls against.
//
// It walks the graph itself rather than sharing `emit/dts.ts`'s walk, which also tracks the
// positions its renderer needs. The two agree because they follow the same edges: a method's
// parameters and result, a property's type, and inside a shape every element, member, branch,
// stream element, function signature and named shape it refers to.
//
// Pure, as the emitters are: no `node:` imports, no file system, clock, randomness or environment,
// and keys sorted, so the same schema always yields the same subset.

import { type ApiShape, FORMAT, type Schema, type SchemaMethod, type SchemaService } from "./schema.ts";

/** What subsetSchema() keeps. */
export interface SubsetOptions {
  /** The service whose holder's reach the subset is: its `entry`. */
  root: string;
  /**
   * Methods to leave out, with whatever is reachable only through them: "method" on every service, or
   * "Service.method" on one, as emitDeclarations() takes them.
   */
  omit?: string[];
}

/**
 * The schema of what a holder of a `root` stub reaches: `root` as its `entry`; every service and named
 * shape reachable from it through methods' parameters and results and through properties; each
 * service's methods less `omit`; and no constants. Services keep the source's `direction`, so a root
 * whose direction is "client" is refused. emitDeclarations(subset, {root}) equals
 * emitDeclarations(schema, {root, omit}). Keys stay sorted. Throws on a root, service or shape the
 * schema does not have.
 */
export function subsetSchema(schema: Schema, options: SubsetOptions): Schema {
  const omitted = new Set(options.omit ?? []);
  const methodsOf = (name: string, service: SchemaService): SchemaMethod[] =>
    service.methods.filter((method) => !omitted.has(method.name) && !omitted.has(`${name}.${method.name}`));

  const root = serviceOf(schema, options.root);
  if (root.direction === "client") {
    throw new Error(`${options.root} is implemented by the client, so no holder reaches anything from it`);
  }

  const services = new Map<string, SchemaService>();
  const shapes = new Map<string, ApiShape>();
  const pending: string[] = [];
  const visitService = (name: string) => {
    if (services.has(name)) return;
    const service = serviceOf(schema, name);
    const copy: SchemaService = {
      doc: service.doc,
      direction: service.direction,
      methods: methodsOf(name, service),
      ...(service.properties === undefined ? {} : { properties: service.properties }),
      ...(service.deprecated === undefined ? {} : { deprecated: service.deprecated }),
    };
    services.set(name, copy);
    pending.push(name);
  };
  const visit = (shape: ApiShape): void => {
    switch (shape.kind) {
      case "array":
      case "set":
        return visit(shape.element);
      case "map":
        return [shape.key, shape.value].forEach(visit);
      case "tuple":
        return [...shape.elements, ...shape.rest ? [shape.rest] : []].forEach(visit);
      case "object":
        return [...Object.values(shape.properties), ...shape.index ? [shape.index] : []].forEach(visit);
      case "union":
        return shape.branches.forEach(visit);
      case "readableStream":
      case "writableStream":
        if (shape.element) visit(shape.element);
        return;
      case "ref": {
        if (shapes.has(shape.name)) return;
        const named = shapeOf(schema, shape.name);
        shapes.set(shape.name, named);
        return visit(named);
      }
      case "function":
        shape.params.forEach((param) => visit(param.type));
        return visit(shape.returns);
      case "stub":
        if (shape.service !== undefined) visitService(shape.service);
        return;
    }
  };

  visitService(options.root);
  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    const service = services.get(name)!;
    for (const method of service.methods) {
      method.params.forEach((param) => visit(param.type));
      visit(method.returns);
    }
    for (const property of service.properties ?? []) visit(property.type);
  }
  return { format: FORMAT, entry: options.root, constants: {}, services: sorted(services), shapes: sorted(shapes) };
}

function serviceOf(schema: Schema, name: string): SchemaService {
  const service = Object.hasOwn(schema.services, name) ? schema.services[name] : undefined;
  if (!service) throw new Error(`no service ${name} in the schema`);
  return service;
}

function shapeOf(schema: Schema, name: string): ApiShape {
  const shape = Object.hasOwn(schema.shapes, name) ? schema.shapes[name] : undefined;
  if (!shape) throw new Error(`no shape ${name} in the schema`);
  return shape;
}

function sorted<T>(map: Map<string, T>): Record<string, T> {
  return Object.fromEntries([...map].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
