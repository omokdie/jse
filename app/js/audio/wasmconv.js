// WebAssembly SIMD kernels for the NHWC Conv2D hot path of audio/tfgraph.js. The module is assembled here from
// raw opcodes (no toolchain needed, ~1 KB) and instantiated synchronously. Three entry points:
//   conv8 — Co % 8 == 0 : two f32x4 accumulators per output pixel/8-channel block, input value splatted
//   conv4 — Co % 4 == 0 : one accumulator per 4-channel block
//   dot1  — Co == 1     : 4-wide dot product along the contiguous (kw, ci) run, scalar tail
// All three take byte addresses/strides: (x, w, out, OH, OW, KH, KWC, xRowStep, xPixStep, xOhStep, wRowStep, wjStep, nBlocks)
// If WebAssembly or SIMD is unavailable the JS kernel is used (same results up to float rounding order).

const u32 = n => { const b = []; do { let x = n & 0x7f; n >>>= 7; if (n) x |= 0x80; b.push(x); } while (n); return b; };
const s32 = n => { const b = []; for (;;) { const x = n & 0x7f; n >>= 7; if ((n === 0 && !(x & 0x40)) || (n === -1 && (x & 0x40))) { b.push(x); return b; } b.push(x | 0x80); } };
const vec = items => [...u32(items.length), ...items.flat()];
const str = s => [...u32(s.length), ...[...s].map(c => c.charCodeAt(0))];
const sect = (id, body) => [id, ...u32(body.length), ...body];

// instruction helpers
const G = i => [0x20, ...u32(i)], S = i => [0x21, ...u32(i)];
const C = v => [0x41, ...s32(v)];
const ADD = [0x6a], SUB = [0x6b], SHL = [0x74], LT_U = [0x49], EQZ = [0x45];
const BLOCK = [0x02, 0x40], LOOP = [0x03, 0x40], END = [0x0b], BR = d => [0x0c, d], BR_IF = d => [0x0d, d];
const F32LOAD = o => [0x2a, 2, ...u32(o)], F32STORE = o => [0x38, 2, ...u32(o)], F32ADD = [0x92], F32MUL = [0x94], F32ZERO = [0x43, 0, 0, 0, 0];
const SIMD = op => [0xfd, ...u32(op)];
const VLOAD = o => [...SIMD(0), 2, ...u32(o)], VSTORE = o => [...SIMD(11), 2, ...u32(o)];
const SPLAT = SIMD(19), VADD = SIMD(228), VMUL = SIMD(230), LANE = l => [...SIMD(31), l];

// params 0..12; extra locals
const [x, w, out, OH, OW, KH, KWC, xRowStep, xPixStep, xOhStep, wRowStep, wjStep, nBlocks] = [...Array(13).keys()];
const oh = 13, ow = 14, b = 15, kh = 16, xOh = 17, xPix = 18, wBlk = 19, xRow = 20, wRow = 21, xp = 22, wp = 23, xend = 24, op = 25, xend4 = 26;
const acc0 = 27, acc1 = 28, xv = 29, sacc = 30;
const LOCALS = vec([[...u32(14), 0x7f], [...u32(3), 0x7b], [...u32(1), 0x7d]]);   // 14 i32, 3 v128, 1 f32

/** while (counter != 0) { body; counter-- } */
const countdown = (counter, init, body) => [...init, ...S(counter), ...BLOCK, ...LOOP, ...G(counter), ...EQZ, ...BR_IF(1), ...body, ...G(counter), ...C(1), ...SUB, ...S(counter), ...BR(0), ...END, ...END];

function convBody(two) {
  const inner = [   // for j in 0..KWC-1 (KWC ≥ 1)
    ...G(xRow), ...S(xp), ...G(wRow), ...S(wp), ...G(xRow), ...G(KWC), ...C(2), ...SHL, ...ADD, ...S(xend),
    ...LOOP,
    ...G(xp), ...F32LOAD(0), ...SPLAT, ...S(xv),
    ...G(acc0), ...G(xv), ...G(wp), ...VLOAD(0), ...VMUL, ...VADD, ...S(acc0),
    ...(two ? [...G(acc1), ...G(xv), ...G(wp), ...VLOAD(16), ...VMUL, ...VADD, ...S(acc1)] : []),
    ...G(xp), ...C(4), ...ADD, ...S(xp), ...G(wp), ...G(wjStep), ...ADD, ...S(wp),
    ...G(xp), ...G(xend), ...LT_U, ...BR_IF(0),
    ...END,
    ...G(xRow), ...G(xRowStep), ...ADD, ...S(xRow), ...G(wRow), ...G(wRowStep), ...ADD, ...S(wRow),
  ];
  const blk = two ? 32 : 16;
  const perBlock = [
    ...F32ZERO, ...SPLAT, ...S(acc0), ...(two ? [...F32ZERO, ...SPLAT, ...S(acc1)] : []),
    ...G(xPix), ...S(xRow), ...G(wBlk), ...S(wRow),
    ...countdown(kh, G(KH), inner),
    ...G(op), ...G(acc0), ...VSTORE(0), ...(two ? [...G(op), ...G(acc1), ...VSTORE(16)] : []),
    ...G(op), ...C(blk), ...ADD, ...S(op), ...G(wBlk), ...C(blk), ...ADD, ...S(wBlk),
  ];
  const perPixel = [...G(w), ...S(wBlk), ...countdown(b, G(nBlocks), perBlock), ...G(xPix), ...G(xPixStep), ...ADD, ...S(xPix)];
  const perRow = [...G(xOh), ...S(xPix), ...countdown(ow, G(OW), perPixel), ...G(xOh), ...G(xOhStep), ...ADD, ...S(xOh)];
  return [...G(out), ...S(op), ...G(x), ...S(xOh), ...countdown(oh, G(OH), perRow), ...END];
}
function dotBody() {
  const inner = [
    ...G(xRow), ...S(xp), ...G(wRow), ...S(wp),
    ...G(xRow), ...G(KWC), ...C(2), ...SHL, ...ADD, ...S(xend),
    ...G(xRow), ...G(KWC), ...C(-4), [0x71] /* i32.and */, ...C(2), ...SHL, ...ADD, ...S(xend4),
    ...BLOCK, ...LOOP, ...G(xp), ...G(xend4), ...LT_U, ...EQZ, ...BR_IF(1),
    ...G(acc0), ...G(xp), ...VLOAD(0), ...G(wp), ...VLOAD(0), ...VMUL, ...VADD, ...S(acc0),
    ...G(xp), ...C(16), ...ADD, ...S(xp), ...G(wp), ...C(16), ...ADD, ...S(wp), ...BR(0), ...END, ...END,
    ...BLOCK, ...LOOP, ...G(xp), ...G(xend), ...LT_U, ...EQZ, ...BR_IF(1),
    ...G(sacc), ...G(xp), ...F32LOAD(0), ...G(wp), ...F32LOAD(0), ...F32MUL, ...F32ADD, ...S(sacc),
    ...G(xp), ...C(4), ...ADD, ...S(xp), ...G(wp), ...C(4), ...ADD, ...S(wp), ...BR(0), ...END, ...END,
    ...G(xRow), ...G(xRowStep), ...ADD, ...S(xRow), ...G(wRow), ...G(wRowStep), ...ADD, ...S(wRow),
  ];
  const perPixel = [
    ...F32ZERO, ...SPLAT, ...S(acc0), ...F32ZERO, ...S(sacc), ...G(xPix), ...S(xRow), ...G(w), ...S(wRow),
    ...countdown(kh, G(KH), inner),
    ...G(op), ...G(acc0), ...LANE(0), ...G(acc0), ...LANE(1), ...F32ADD, ...G(acc0), ...LANE(2), ...F32ADD, ...G(acc0), ...LANE(3), ...F32ADD, ...G(sacc), ...F32ADD, ...F32STORE(0),
    ...G(op), ...C(4), ...ADD, ...S(op),
    ...G(xPix), ...G(xPixStep), ...ADD, ...S(xPix),
  ];
  const perRow = [...G(xOh), ...S(xPix), ...countdown(ow, G(OW), perPixel), ...G(xOh), ...G(xOhStep), ...ADD, ...S(xOh)];
  return [...G(out), ...S(op), ...G(x), ...S(xOh), ...countdown(oh, G(OH), perRow), ...END];
}
function moduleBytes() {
  const type = [0x60, ...vec(Array(13).fill([0x7f])), 0x00];
  const bodies = [convBody(true), convBody(false), dotBody()].map(body => { const f = [...LOCALS, ...body]; return [...u32(f.length), ...f]; });
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...sect(1, vec([type])),
    ...sect(3, vec([[0], [0], [0]])),
    ...sect(5, vec([[0x00, ...u32(64)]])),                         // 64 pages = 4 MiB to start, grows on demand
    ...sect(7, vec([[...str('conv8'), 0, 0], [...str('conv4'), 0, 1], [...str('dot1'), 0, 2], [...str('mem'), 2, 0]])),
    ...sect(10, vec(bodies)),
  ]);
}

let inst = null, failed = false;
export function wasmAvailable() {
  if (inst) return true; if (failed) return false;
  try {
    const bytes = moduleBytes();
    if (typeof WebAssembly === 'undefined' || !WebAssembly.validate(bytes)) { failed = true; return false; }
    inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), {}).exports;
    return true;
  } catch { failed = true; return false; }
}

/** Same contract as tfgraph's JS kernel: padded input xp [Hp][Wp][Ci], filter w [KH][KW][Ci][Co] → out [OH][OW][Co]. */
export function wasmConvKernel(xpArr, Hp, Wp, Ci, wArr, KHn, KWn, Co, OHn, OWn, sh, sw) {
  if (!inst) return null;
  const kind = Co === 1 ? 'dot1' : Co % 8 === 0 ? 'conv8' : Co % 4 === 0 ? 'conv4' : null;
  if (!kind) return null;
  const xBytes = xpArr.length * 4, wBytes = wArr.length * 4, oBytes = OHn * OWn * Co * 4;
  const need = 16 + xBytes + 16 + wBytes + 16 + oBytes + 64;
  const mem = inst.mem;
  if (mem.buffer.byteLength < need) mem.grow(Math.ceil((need - mem.buffer.byteLength) / 65536));
  const al = n => (n + 15) & ~15;
  const xOff = 0, wOff = al(xOff + xBytes), oOff = al(wOff + wBytes);
  const f = new Float32Array(mem.buffer);
  f.set(xpArr, xOff >> 2); f.set(wArr, wOff >> 2);
  const KWC = KWn * Ci, rowStride = Wp * Ci * 4;
  inst[kind](xOff, wOff, oOff, OHn, OWn, KHn, KWC, rowStride, sw * Ci * 4, sh * rowStride, KWC * Co * 4, Co * 4, Co === 1 ? 1 : Co / (kind === 'conv8' ? 8 : 4));
  return new Float32Array(mem.buffer, oOff, OHn * OWn * Co).slice();
}
