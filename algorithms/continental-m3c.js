/*
 * Continental (Siemens VDO) M3C, MC9S12X internal flash (KTM / Husqvarna two-strokes).
 *
 * The flash is a set of 16 KB pages (PPAGE window 0x8000-0xBFFF). Several segments start with a
 * checksum descriptor:
 *
 *   FF FF FF FF  crc:u16  count:u16  { start:u32  end:u32 } * count
 *
 * start/end are banked addresses 00 PP AAAA (page, window address), end inclusive. crc is
 * CRC-16/MODBUS (poly 0x8005 reflected, init 0xFFFF, no xorout), big-endian, over the
 * listed ranges in order. A 256 KB read holds four descriptors (code, boot and the
 * calibration block at 0x6804 that a tune changes). Page PP sits at file offset
 * (PP mod pages) * 0x4000, since the 256 KB part aliases E0-EF onto F0-FF.
 */
(function (R) {
  "use strict";

  const PAGE = 0x4000;
  let table = null;

  function crc16(bytes, ranges) {
    if (!table) {
      table = new Uint16Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xA001 : c >>> 1;
        table[n] = c;
      }
    }
    let crc = 0xFFFF;
    for (const [s, e] of ranges) {
      for (let i = s; i <= e; i++) crc = (crc >>> 8) ^ table[(crc ^ bytes[i]) & 0xFF];
    }
    return crc;
  }

  function toOffset(addr, size) {
    const page = (addr >>> 16) & 0xFF, win = addr & 0xFFFF;
    if (addr >>> 24 || page < 0xE0 || win < 0x8000 || win > 0xBFFF) return -1;
    return (page % (size / PAGE)) * PAGE + (win - 0x8000);
  }

  function parse(bytes, i) {
    if (bytes[i - 4] !== 0xFF || bytes[i - 3] !== 0xFF || bytes[i - 2] !== 0xFF || bytes[i - 1] !== 0xFF) return null;
    const count = (bytes[i + 2] << 8) | bytes[i + 3];
    if (count < 1 || count > 32 || i + 4 + count * 8 > bytes.length) return null;
    const ranges = [], addrs = [];
    for (let k = 0; k < count; k++) {
      const p = i + 4 + k * 8;
      const sa = R.readU32BE(bytes, p), ea = R.readU32BE(bytes, p + 4);
      const s = toOffset(sa, bytes.length), e = toOffset(ea, bytes.length);
      if (s < 0 || e < s || (sa >>> 16) !== (ea >>> 16)) return null;
      // A range must not cover its own descriptor.
      if (s <= i + 1 && e >= i) return null;
      ranges.push([s, e]);
      addrs.push([sa, ea]);
    }
    return { offset: i, ranges, addrs };
  }

  function find(bytes) {
    const n = bytes.length;
    if (n < 4 * PAGE || n > 0x100000 || n % PAGE || (n & (n - 1))) return [];
    const out = [];
    for (let i = 4; i + 12 <= n; i += 0x100) {
      const d = parse(bytes, i);
      if (d) out.push(d);
    }
    // Real images carry several descriptors; a single hit is most likely chance.
    return out.length >= 2 ? out : [];
  }

  const ga = (a) => ((a >>> 16) & 0xFF).toString(16).toUpperCase() + ":" + (a & 0xFFFF).toString(16).toUpperCase().padStart(4, "0");

  R.register({
    id: "continental-m3c",
    name: "Continental M3C (MC9S12X)",
    status: "confirmed",
    description: "CRC-16/MODBUS over the ranges listed in each FFFFFFFF-prefixed descriptor (calibration CRC at 0x6804 on 256 KB reads).",
    tested: ["Husqvarna TE300i 2020 - KM557EU2025002"],

    verify(bytes) {
      return find(bytes).map((d) => {
        const stored = (bytes[d.offset] << 8) | bytes[d.offset + 1];
        const computed = crc16(bytes, d.ranges);
        return {
          label: "CRC-16 of " + d.addrs.length + " range(s) " + ga(d.addrs[0][0]) + " .. " + ga(d.addrs[d.addrs.length - 1][1]),
          offset: d.offset,
          start: Math.min(...d.ranges.map((r) => r[0])),
          end: Math.max(...d.ranges.map((r) => r[1])),
          stored: stored, computed: computed, ok: stored === computed,
        };
      });
    },

    apply(bytes) {
      const out = new Uint8Array(bytes);
      const ds = find(out);
      if (!ds.length) throw new Error("not a Continental M3C image");
      // Two passes in case one block's ranges cover another block's CRC.
      for (let pass = 0; pass < 2; pass++) {
        for (const d of ds) {
          const v = crc16(out, d.ranges);
          out[d.offset] = v >> 8;
          out[d.offset + 1] = v & 0xFF;
        }
      }
      return out;
    },
  });
})(self.ChecksumRegistry);
