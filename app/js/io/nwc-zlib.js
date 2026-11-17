// JSE — zlib streams for the compressed .nwc container ("[NWZ]\0" + zlib data).
// Uses the platform's (De)CompressionStream when there is one; otherwise a small pure-JS
// inflate (RFC 1951) and a "stored blocks" deflate, so old WebViews still open and save files.

/** Pure JS inflate of a zlib stream (RFC 1950 header + RFC 1951 data). */
export function inflateZlibSync(src) {
  let pos = 0, bitBuf = 0, bitCnt = 0;
  if (src.length < 6 || (src[0] & 0x0f) !== 8 || ((src[0] << 8) | src[1]) % 31 !== 0) throw new Error('zlib 데이터가 아닙니다');
  pos = 2;
  if (src[1] & 0x20) pos += 4;                              // preset dictionary id (not used by NWC)
  let out = new Uint8Array(Math.max(1024, src.length * 4)); let op = 0;
  const need = (n) => { if (op + n > out.length) { const bigger = new Uint8Array(Math.max(out.length * 2, op + n)); bigger.set(out.subarray(0, op)); out = bigger; } };
  const bits = (n) => {
    while (bitCnt < n) { if (pos >= src.length) throw new Error('압축 데이터가 중간에 끝났습니다'); bitBuf |= src[pos++] << bitCnt; bitCnt += 8; }
    const v = bitBuf & ((1 << n) - 1); bitBuf >>>= n; bitCnt -= n; return v;
  };
  // canonical Huffman table: counts per length + symbols ordered by code
  const build = (lengths) => {
    const count = new Uint16Array(16), offs = new Uint16Array(16), symbol = new Uint16Array(lengths.length);
    for (const l of lengths) count[l]++;
    count[0] = 0;
    for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + count[i - 1];
    for (let i = 0; i < lengths.length; i++) if (lengths[i]) symbol[offs[lengths[i]]++] = i;
    return { count, symbol };
  };
  const decode = (h) => {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len < 16; len++) {
      code |= bits(1);
      const c = h.count[len];
      if (code - c < first) return h.symbol[index + (code - first)];
      index += c; first += c; first <<= 1; code <<= 1;
    }
    throw new Error('압축 데이터가 손상되었습니다');
  };
  const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  let fixed = null;
  const codes = (lit, dist) => {
    for (;;) {
      const sym = decode(lit);
      if (sym < 256) { need(1); out[op++] = sym; continue; }
      if (sym === 256) return;
      const li = sym - 257;
      if (li >= 29) throw new Error('압축 데이터가 손상되었습니다');
      const len = LBASE[li] + bits(LEXT[li]);
      const di = decode(dist);
      if (di >= 30) throw new Error('압축 데이터가 손상되었습니다');
      const d = DBASE[di] + bits(DEXT[di]);
      if (d > op) throw new Error('압축 데이터가 손상되었습니다');
      need(len);
      for (let i = 0; i < len; i++, op++) out[op] = out[op - d];
    }
  };
  let last = 0;
  while (!last) {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      bitBuf = 0; bitCnt = 0;
      if (pos + 4 > src.length) throw new Error('압축 데이터가 중간에 끝났습니다');
      const len = src[pos] | (src[pos + 1] << 8); pos += 4;
      if (pos + len > src.length) throw new Error('압축 데이터가 중간에 끝났습니다');
      need(len); out.set(src.subarray(pos, pos + len), op); op += len; pos += len;
    } else if (type === 1) {
      if (!fixed) {
        const l = new Uint8Array(288);
        l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288);
        fixed = { lit: build(l), dist: build(new Uint8Array(30).fill(5)) };
      }
      codes(fixed.lit, fixed.dist);
    } else if (type === 2) {
      const nlen = bits(5) + 257, ndist = bits(5) + 1, ncode = bits(4) + 4;
      const order = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
      const cl = new Uint8Array(19);
      for (let i = 0; i < ncode; i++) cl[order[i]] = bits(3);
      const clh = build(cl);
      const lengths = new Uint8Array(nlen + ndist);
      for (let i = 0; i < nlen + ndist;) {
        const sym = decode(clh);
        if (sym < 16) lengths[i++] = sym;
        else {
          let prev = 0, rep;
          if (sym === 16) { if (!i) throw new Error('압축 데이터가 손상되었습니다'); prev = lengths[i - 1]; rep = 3 + bits(2); }
          else if (sym === 17) rep = 3 + bits(3);
          else rep = 11 + bits(7);
          if (i + rep > nlen + ndist) throw new Error('압축 데이터가 손상되었습니다');
          while (rep--) lengths[i++] = prev;
        }
      }
      codes(build(lengths.subarray(0, nlen)), build(lengths.subarray(nlen)));
    } else throw new Error('압축 데이터가 손상되었습니다');
  }
  return out.slice(0, op);
}

function adler32(u8) {
  let a = 1, b = 0;
  for (let i = 0; i < u8.length;) {
    const end = Math.min(u8.length, i + 3800);
    for (; i < end; i++) { a += u8[i]; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}
/** Valid zlib stream without compression (stored blocks). */
export function deflateStoredSync(u8) {
  const blocks = Math.max(1, Math.ceil(u8.length / 65535));
  const out = new Uint8Array(2 + u8.length + blocks * 5 + 4);
  let p = 0; out[p++] = 0x78; out[p++] = 0x01;
  for (let i = 0, k = 0; k < blocks; k++) {
    const n = Math.min(65535, u8.length - i);
    out[p++] = k === blocks - 1 ? 1 : 0;
    out[p++] = n & 255; out[p++] = n >> 8; out[p++] = ~n & 255; out[p++] = (~n >> 8) & 255;
    out.set(u8.subarray(i, i + n), p); p += n; i += n;
  }
  const a = adler32(u8);
  out[p++] = a >>> 24; out[p++] = (a >>> 16) & 255; out[p++] = (a >>> 8) & 255; out[p++] = a & 255;
  return out;
}

async function pipe(u8, stream) {
  const res = new Response(new Blob([u8]).stream().pipeThrough(stream));
  return new Uint8Array(await res.arrayBuffer());
}
export async function inflateZlib(u8) {
  if (typeof DecompressionStream === 'function' && typeof Response === 'function' && typeof Blob === 'function') {
    try { return await pipe(u8, new DecompressionStream('deflate')); } catch (_) { /* damaged tail or old engine: try the JS inflate */ }
  }
  return inflateZlibSync(u8);
}
export async function deflateZlib(u8) {
  if (typeof CompressionStream === 'function' && typeof Response === 'function' && typeof Blob === 'function') {
    try { return await pipe(u8, new CompressionStream('deflate')); } catch (_) { /* fall through */ }
  }
  return deflateStoredSync(u8);
}
