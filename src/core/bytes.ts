/**
 * Little-endian readers and the (cmd, data) variable-length command
 * decoder from the MMB spec ("Encoding and types").
 */

export class Bytes {
  readonly view: DataView;
  constructor(readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  get length(): number {
    return this.buf.byteLength;
  }

  has(offset: number, size: number): boolean {
    return offset >= 0 && size >= 0 && offset + size <= this.length;
  }

  u8(o: number): number {
    return this.view.getUint8(o);
  }
  u16(o: number): number {
    return this.view.getUint16(o, true);
  }
  u32(o: number): number {
    return this.view.getUint32(o, true);
  }
  u64(o: number): bigint {
    return this.view.getBigUint64(o, true);
  }

  /** Four ASCII bytes as a string, with non-printables escaped. */
  str4(o: number): string {
    let s = "";
    for (let i = 0; i < 4; i++) {
      const c = this.u8(o + i);
      s += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : `\\x${c.toString(16).padStart(2, "0")}`;
    }
    return s;
  }

  /**
   * Length of the NUL-terminated string at `o`, not counting the NUL.
   * Returns -1 if no NUL is found before the end of the file.
   */
  cstrLength(o: number): number {
    for (let i = o; i < this.length; i++) {
      if (this.buf[i] === 0) return i - o;
    }
    return -1;
  }

  utf8(o: number, len: number): string {
    return decoder.decode(this.buf.subarray(o, o + len));
  }

  allZero(start: number, end: number): boolean {
    for (let i = start; i < end; i++) if (this.buf[i] !== 0) return false;
    return true;
  }
}

const decoder = new TextDecoder("utf-8", { fatal: false });

/** A decoded (cmd, data) pair. */
export interface Cmd {
  /** Byte offset of the first byte. */
  offset: number;
  /** Total encoded size, 1 to 5 bytes. */
  size: number;
  /** Low six bits of the first byte. */
  op: number;
  /** Data field; 0 when the length tag is 0. */
  data: number;
  /** Number of data bytes (0, 1, 2, 4), from the top two bits. */
  dataBytes: 0 | 1 | 2 | 4;
}

const DATA_BYTES: readonly (0 | 1 | 2 | 4)[] = [0, 1, 2, 4];

/**
 * Decode the command at `offset`, bounded by `limit` (exclusive).
 * Returns undefined if the command is truncated.
 */
export function readCmd(b: Bytes, offset: number, limit: number = b.length): Cmd | undefined {
  if (offset < 0 || offset >= limit || offset >= b.length) return undefined;
  const first = b.u8(offset);
  const op = first & 0x3f;
  const dataBytes = DATA_BYTES[first >> 6]!;
  const size = 1 + dataBytes;
  if (offset + size > limit || offset + size > b.length) return undefined;
  let data = 0;
  switch (dataBytes) {
    case 0:
      break;
    case 1:
      data = b.u8(offset + 1);
      break;
    case 2:
      data = b.u16(offset + 1);
      break;
    case 4:
      data = b.u32(offset + 1);
      break;
  }
  return { offset, size, op, data, dataBytes };
}

export function hex(n: number | bigint, width = 0): string {
  const s = n.toString(16);
  return "0x" + (width ? s.padStart(width, "0") : s);
}

/** Two-digit hex byte. */
export function hex2(n: number): string {
  return n.toString(16).padStart(2, "0");
}

/** Offset formatted for hexdump gutters. */
export function hexOffset(n: number, width = 8): string {
  return n.toString(16).padStart(width, "0");
}
