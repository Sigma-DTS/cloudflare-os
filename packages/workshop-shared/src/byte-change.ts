/** Immutable, workspace-local bytes. An ID is a consistency identity, not read authority. */
export interface BytesRef {
  /** Opaque content identity, resolved only through a scoped worktree capability. */
  id: string;
  /** Exact length in bytes, including zero for an empty file. */
  byteLength: number;
}

/** A range of immutable bytes; inserts never embed bulk data in an OT. */
export interface ByteSlice {
  /** Immutable source, staged durably before publishing a transform. */
  source: BytesRef;
  /** Zero-based byte offset. */
  offset: number;
  /** Positive number of bytes. */
  length: number;
}

/** Byte-coordinate splice OT. Sections consume exactly beforeBytes, without reading payloads. */
export interface ByteChange {
  /** Exact size of the file the transform applies to. */
  beforeBytes: number;
  /** Retain count, or [delete count, ...immutable inserts], in original-file coordinates. */
  sections: (number | [number, ...ByteSlice[]])[];
}

/** A byte postimage; the optional transform is relative to the immutable base. */
export interface ByteValue {
  /** Immutable base; neither changes nor readers may mutate it. */
  base: BytesRef;
  /** Optional compact delta; replacement semantics are independent of this storage encoding. */
  edit?: ByteChange;
}

/** Validate byte-reference arithmetic without trusting a client's declared length or identity. */
export function validateBytesRef(ref: BytesRef): void {
  if (!/^[A-Za-z0-9:_-]{1,160}$/.test(ref.id) || !size(ref.byteLength)) {
    throw new Error("Invalid immutable byte reference.");
  }
}

const size = (n: number) => Number.isSafeInteger(n) && n >= 0;
const add = (a: number, b: number) => {
  const result = a + b;
  if (!size(result)) throw new Error("Byte length exceeds safe integer range.");
  return result;
};

/** Validate a splice's tiling, bounds and nonempty sections before composing or transforming it. */
export function validateByteChange(change: ByteChange): void {
  if (!size(change.beforeBytes) || change.sections.length > 16_384) throw new Error("Invalid byte transform size.");
  let consumed = 0, produced = 0;
  for (const section of change.sections) {
    if (typeof section === "number") {
      if (!size(section) || !section) throw new Error("Invalid byte retain.");
      consumed = add(consumed, section); produced = add(produced, section);
    } else {
      if (!size(section[0]) || section.length > 16_384 || (section[0] === 0 && section.length === 1)) {
        throw new Error("Invalid byte splice.");
      }
      consumed = add(consumed, section[0]);
      for (const slice of section.slice(1) as ByteSlice[]) {
        validateBytesRef(slice.source);
        if (!size(slice.offset) || !size(slice.length) || !slice.length ||
            add(slice.offset, slice.length) > slice.source.byteLength) throw new Error("Invalid byte slice.");
        produced = add(produced, slice.length);
      }
    }
  }
  if (consumed !== change.beforeBytes) throw new Error("Byte transform does not tile its base.");
}

/** Size of a byte postimage without fetching any source bytes. */
export function byteValueLength(value: ByteValue): number {
  return value.edit ? byteChangeLength(value.edit) : value.base.byteLength;
}

/** Size of a splice's result; input must already be schema-valid. */
export function byteChangeLength(change: ByteChange): number {
  return change.sections.reduce<number>((length, section) => typeof section === "number" ? length + section :
    length + (section.slice(1) as ByteSlice[]).reduce((n, slice) => n + slice.length, 0), 0);
}

/** Compose a splice onto a byte postimage, keeping immutable payloads out of the operation. */
export function applyByteChange(value: ByteValue, change: ByteChange): ByteValue {
  if (byteValueLength(value) !== change.beforeBytes) throw new Error("Byte transform length mismatch.");
  return {base: value.base, edit: value.edit ? composeByteChange(value.edit, change) : change};
}

type Token = {kind: "retain"; length: number} | {kind: "delete"; length: number} | {kind: "insert"; length: number; slice: ByteSlice};
function tokens(change: ByteChange): Token[] {
  validateByteChange(change);
  const result: Token[] = [];
  for (const section of change.sections) {
    if (typeof section === "number") result.push({kind: "retain", length: section});
    else {
      if (section[0]) result.push({kind: "delete", length: section[0]});
      for (const slice of section.slice(1) as ByteSlice[]) result.push({kind: "insert", length: slice.length, slice});
    }
  }
  return result;
}
class Input {
  #index = 0;
  #offset = 0;
  constructor(private items: Token[]) {}
  get current(): Token | undefined { return this.items[this.#index]; }
  get length(): number { return this.current!.length - this.#offset; }
  take(n = this.length): Token {
    const token = this.current!;
    const part: Token = token.kind === "insert" ? {kind: "insert", length: n,
      slice: {...token.slice, offset: token.slice.offset + this.#offset, length: n}} : {kind: token.kind, length: n};
    this.#offset += n;
    if (this.#offset === token.length) { this.#index++; this.#offset = 0; }
    return part;
  }
}
class Output {
  sections: ByteChange["sections"] = [];
  push(token: Token) {
    if (!token.length) return;
    const last = this.sections.at(-1);
    if (token.kind === "retain") {
      if (typeof last === "number") this.sections[this.sections.length - 1] = last + token.length;
      else this.sections.push(token.length);
    } else {
      const section: [number, ...ByteSlice[]] = Array.isArray(last) ? last : [0];
      if (section !== last) this.sections.push(section);
      if (token.kind === "delete") section[0] += token.length;
      else {
        const previous = section.at(-1);
        if (previous !== undefined && typeof previous !== "number" && previous.source.id === token.slice.source.id &&
            previous.source.byteLength === token.slice.source.byteLength &&
            previous.offset + previous.length === token.slice.offset) previous.length += token.length;
        else section.push({...token.slice});
      }
    }
  }
}

/** Compose sequential byte OTs in O(sections), without hashing, fetching or diffing a file. */
export function composeByteChange(a: ByteChange, b: ByteChange): ByteChange {
  if (byteChangeLength(a) !== b.beforeBytes) throw new Error("Byte transforms do not chain.");
  const left = new Input(tokens(a)), right = new Input(tokens(b)), out = new Output();
  while (left.current || right.current) {
    if (left.current?.kind === "delete") { out.push(left.take()); continue; }
    if (right.current?.kind === "insert") { out.push(right.take()); continue; }
    if (!left.current || !right.current) throw new Error("Byte transforms do not chain.");
    const n = Math.min(left.length, right.length), x = left.take(n), y = right.take(n);
    if (y.kind === "retain") out.push(x);
    else if (x.kind === "retain") out.push({kind: "delete", length: n});
  }
  return {beforeBytes: a.beforeBytes, sections: out.sections};
}

/** Transform concurrent byte OTs. Earlier canonical inserts precede later inserts at a tie. */
export function transformByteChange(a: ByteChange, b: ByteChange): {a: ByteChange; b: ByteChange} {
  if (a.beforeBytes !== b.beforeBytes) throw new Error("Byte transforms have different bases.");
  const left = new Input(tokens(a)), right = new Input(tokens(b)), x = new Output(), y = new Output();
  while (left.current || right.current) {
    if (left.current?.kind === "insert") {
      const token = left.take(); x.push(token); y.push({kind: "retain", length: token.length}); continue;
    }
    if (right.current?.kind === "insert") {
      const token = right.take(); y.push(token); x.push({kind: "retain", length: token.length}); continue;
    }
    if (!left.current || !right.current) throw new Error("Byte transforms have different bases.");
    const n = Math.min(left.length, right.length), l = left.take(n), r = right.take(n);
    if (l.kind === "retain" && r.kind === "retain") { x.push(l); y.push(r); }
    else if (l.kind === "delete" && r.kind === "retain") x.push(l);
    else if (l.kind === "retain" && r.kind === "delete") y.push(r);
  }
  return {a: {beforeBytes: byteChangeLength(b), sections: x.sections},
    b: {beforeBytes: byteChangeLength(a), sections: y.sections}};
}
