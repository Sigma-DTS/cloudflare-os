import { expect, it } from "vitest";
import { composeByteChange, transformByteChange, validateByteChange, type ByteChange, type ByteSlice } from "@gadgets/workshop-shared/byte-change";
import { applyCodeChange, transformCodeChange } from "@gadgets/workshop-shared/code-change";

const payloads = new Map<string, number[]>();
function splice(size: number, start: number, remove: number, insert: number[]): ByteChange {
  const id = `insert-${payloads.size}`;
  payloads.set(id, insert);
  return {beforeBytes: size, sections: [
    ...(start ? [start] : []),
    ...(remove || insert.length ? [[remove, ...(insert.length ? [{source: {id, byteLength: insert.length}, offset: 0, length: insert.length}] : [])] as [number, ...ByteSlice[]]] : []),
    ...(size - start - remove ? [size - start - remove] : []),
  ]};
}
function apply(base: number[], change: ByteChange): number[] {
  validateByteChange(change);
  let offset = 0;
  const result: number[] = [];
  for (const section of change.sections) {
    if (typeof section === "number") { result.push(...base.slice(offset, offset + section)); offset += section; }
    else { offset += section[0]; for (const slice of section.slice(1) as ByteSlice[]) result.push(...payloads.get(slice.source.id)!.slice(slice.offset, slice.offset + slice.length)); }
  }
  return result;
}

it("composes and converges overlapping, tied, deleted and empty byte ranges", () => {
  let random = 0x9e3779b9;
  const next = (max: number) => { random ^= random << 13; random ^= random >>> 17; random ^= random << 5; return (random >>> 0) % max; };
  for (let i = 0; i < 2000; ++i) {
    const base = Array.from({length: next(25)}, (_, i) => i);
    const edit = (length: number) => { const start = next(length + 1); return splice(length, start, next(length - start + 1), Array.from({length: next(5)}, () => next(256))); };
    const a = edit(base.length), b = edit(base.length), pair = transformByteChange(a, b);
    expect(apply(apply(base, a), pair.b)).toEqual(apply(apply(base, b), pair.a));
    const tail = edit(apply(base, a).length);
    expect(apply(base, composeByteChange(a, tail))).toEqual(apply(apply(base, a), tail));
  }
});

it("rejects malformed ranges and keeps byte and UTF-16 coordinates distinct", () => {
  expect(() => validateByteChange({beforeBytes: 1, sections: [2]})).toThrow();
  expect(() => validateByteChange({beforeBytes: 0, sections: [[0, {source: {id: "a", byteLength: 1}, offset: 1, length: 1}]]})).toThrow();
  expect(() => transformCodeChange({1: [["a", {edit: [1]}]]}, {1: [["a", {editBytes: {beforeBytes: 1, sections: [1]}}]]})).toThrow();
  const bytes = {base: {id: "a", byteLength: 4}};
  expect(applyCodeChange(new Map([[1, new Map([["a", bytes]])]]), {1: [["a", {remove: true}]]}).get(1)?.size).toBe(0);
});

it("preserves OT laws across compound splices and already-composed deltas", () => {
  let random = 1234567;
  const next = (max: number) => {random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random % max;};
  const edit = (length: number) => {
    let result: ByteChange = {beforeBytes: length, sections: length ? [length] : []};
    for (let i = 0; i < 4; i++) {
      const size = apply(Array.from({length}, (_, n) => n), result).length;
      const start = next(size + 1);
      result = composeByteChange(result, splice(size, start, next(size - start + 1), Array.from({length: next(5)}, () => next(256))));
    }
    return result;
  };
  for (let i = 0; i < 1000; i++) {
    const base = Array.from({length: next(30)}, (_, n) => n);
    const a = edit(base.length), b = edit(base.length), pair = transformByteChange(a, b);
    expect(apply(apply(base, a), pair.b)).toEqual(apply(apply(base, b), pair.a));
    const tail = edit(apply(base, a).length);
    expect(apply(base, composeByteChange(a, tail))).toEqual(apply(apply(base, a), tail));
  }
});
