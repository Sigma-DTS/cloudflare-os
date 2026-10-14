/** Identity and length of an immutable whole-file payload; possession alone grants no authority. */
export interface BytesRef {
  /** Opaque identity assigned by the byte store. */
  id: string;
  /** Exact payload length in bytes. */
  byteLength: number;
}

/** Opaque binary file content. Binary mutations replace the entire payload, never splice it. */
export interface ByteValue {
  /** Immutable whole-file payload. */
  base: BytesRef;
}

/** Validate byte-reference metadata without granting access to the named payload. */
export function validateBytesRef(ref: BytesRef): void {
  if (!/^[A-Za-z0-9:_-]{1,160}$/.test(ref.id) || !Number.isSafeInteger(ref.byteLength) || ref.byteLength < 0) {
    throw new Error("Invalid immutable byte reference.");
  }
}
