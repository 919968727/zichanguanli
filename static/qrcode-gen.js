/* qrcode-gen.js —— 极简 QR 编码器（Byte 模式，纠错级别 L，版本 1-5）
 * 修复：格式信息（15 bits）在第一份/第二份副本中的写入位置
 *   - 第一份（左上 L 形）: bit0-5 → m[0..5][8]，bit6 → m[7][8]，bit7 → m[8][8]，
 *                        bit8 → m[8][7]，bit9-14 → m[8][14-k]
 *   - 第二份（右上横排 + 左下竖列）: bit0-7 → m[8][size-1..size-8]，
 *                                 bit8-14 → m[size-15+k][8]
 */
(function (global) {
  'use strict';

  /* ---------- GF(256) ---------- */
  var EXP = new Array(256), LOG = new Array(256);
  for (var i = 0; i < 8; i++) EXP[i] = 1 << i;
  for (i = 8; i < 256; i++) EXP[i] = EXP[i - 4] ^ EXP[i - 5] ^ EXP[i - 6] ^ EXP[i - 8];
  for (i = 0; i < 255; i++) LOG[EXP[i]] = i;

  function gexp(n) { while (n < 0) n += 255; while (n >= 255) n -= 255; return EXP[n]; }
  function glog(n) { if (n < 1) throw new Error('glog(' + n + ')'); return LOG[n]; }

  /* ---------- 版本表（纠错 L，单块） ---------- */
  var VER = {
    1: { data: 19,  ec: 7,  align: [] },
    2: { data: 34,  ec: 10, align: [6, 18] },
    3: { data: 55,  ec: 15, align: [6, 22] },
    4: { data: 80,  ec: 20, align: [6, 26] },
    5: { data: 108, ec: 26, align: [6, 30] }
  };

  /* ---------- UTF-8 ---------- */
  function utf8Bytes(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
      else if (c >= 0xD800 && c <= 0xDBFF) {
        var c2 = str.charCodeAt(++i);
        var cp = 0x10000 + ((c & 0x3FF) << 10) + (c2 & 0x3FF);
        out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F),
                 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
      } else {
        out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
      }
    }
    return out;
  }

  /* ---------- 数据码字 ---------- */
  function toDataCodewords(bytes, ver) {
    var cap = VER[ver].data;
    var bits = [];
    function push(val, len) {
      for (var i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
    }
    push(4, 4);                 // Byte 模式
    push(bytes.length, 8);      // 版本 1-9：8 位字符计数
    for (var i = 0; i < bytes.length; i++) push(bytes[i], 8);

    var total = cap * 8;
    var term = Math.min(4, total - bits.length);
    for (i = 0; i < term; i++) bits.push(0);
    while (bits.length % 8 !== 0) bits.push(0);

    var out = [];
    for (i = 0; i < bits.length; i += 8) {
      var b = 0;
      for (var j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      out.push(b);
    }
    var pads = [0xEC, 0x11], p = 0;
    while (out.length < cap) out.push(pads[p++ % 2]);
    return out;
  }

  /* ---------- Reed-Solomon ---------- */
  function polyMul(a, b) {
    var out = new Array(a.length + b.length - 1).fill(0);
    for (var i = 0; i < a.length; i++) {
      if (a[i] === 0) continue;
      for (var j = 0; j < b.length; j++) {
        if (b[j] === 0) continue;
        out[i + j] ^= gexp(glog(a[i]) + glog(b[j]));
      }
    }
    return out;
  }

  function polyMod(dividend, divisor) {
    var out = dividend.slice();
    var dl = divisor.length;
    for (var i = 0; i <= out.length - dl; i++) {
      if (out[i] === 0) continue;
      var factor = glog(out[i]) - glog(divisor[0]);
      for (var j = 0; j < dl; j++) {
        out[i + j] ^= gexp(glog(divisor[j]) + factor);
      }
    }
    return out.slice(out.length - (dl - 1));
  }

  function ecCodewords(data, ecLen) {
    var gen = [1];
    for (var i = 0; i < ecLen; i++) gen = polyMul(gen, [1, gexp(i)]);
    var buf = data.concat(new Array(ecLen).fill(0));
    return polyMod(buf, gen);
  }

  /* ---------- BCH / 掩码 ---------- */
  function bchDigit(d) { var n = 0; while (d !== 0) { n++; d >>>= 1; } return n; }

  function bchTypeInfo(data) {
    var d = data << 10;
    while (bchDigit(d) - bchDigit(0x537) >= 0) {
      d ^= (0x537 << (bchDigit(d) - bchDigit(0x537)));
    }
    return ((data << 10) | d) ^ 0x5412;
  }

  function maskFn(mask, i, j) {
    switch (mask) {
      case 0: return (i + j) % 2 === 0;
      case 1: return i % 2 === 0;
      case 2: return j % 3 === 0;
      case 3: return (i + j) % 3 === 0;
      case 4: return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
      case 5: return ((i * j) % 2) + ((i * j) % 3) === 0;
      case 6: return (((i * j) % 2) + ((i * j) % 3)) % 2 === 0;
      case 7: return (((i * j) % 3) + ((i + j) % 2)) % 2 === 0;
    }
    return false;
  }

  /* ---------- 矩阵 ---------- */
  function makeMatrix(version, allBytes) {
    var size = version * 4 + 17;
    var m = [];
    for (var i = 0; i < size; i++) m.push(new Array(size).fill(null));

    /* 定位图案 + 分隔符（含四周 -1 的静区分隔带标记） */
    [[0, 0], [size - 7, 0], [0, size - 7]].forEach(function (p) {
      var pr = p[0], pc = p[1];
      for (var r = -1; r <= 7; r++) {
        for (var c = -1; c <= 7; c++) {
          var rr = pr + r, cc = pc + c;
          if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
          m[rr][cc] =
            (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
            (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
            (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        }
      }
    });

    /* 对齐图案 */
    var ap = VER[version].align;
    for (var a = 0; a < ap.length; a++) {
      for (var b = 0; b < ap.length; b++) {
        var ar = ap[a], ac = ap[b];
        if (m[ar][ac] !== null) continue;
        for (var dr = -2; dr <= 2; dr++) {
          for (var dc = -2; dc <= 2; dc++) {
            m[ar + dr][ac + dc] =
              (dr === -2 || dr === 2 || dc === -2 || dc === 2 || (dr === 0 && dc === 0));
          }
        }
      }
    }

    /* 时序图案 */
    for (var t = 8; t < size - 8; t++) {
      if (m[t][6] === null) m[t][6] = (t % 2 === 0);
      if (m[6][t] === null) m[6][t] = (t % 2 === 0);
    }

    /* ============================================================
     * 格式信息（15 bits，纠错 L(01) + mask 0，异或 0x5412）
     *   第一份（左上 L 形）：
     *     bits 0..5  → m[0..5][8]（左侧竖列）
     *     bit  6     → m[7][8]
     *     bit  7     → m[8][8]
     *     bit  8     → m[8][7]
     *     bits 9..14 → m[8][5..0]（顶部横排，从右向左）
     *   第二份（右上横排 + 左下竖列）：
     *     bits 0..7  → m[8][size-1..size-8]（右上横排，从右向左）
     *     bits 8..14 → m[size-7..size-1][8]（左下竖列，从上到下）
     * ============================================================ */
    var mask = 0;
    var fmt = bchTypeInfo((1 << 3) | mask);

    // 第一份副本
    for (var k = 0; k <= 5; k++) m[k][8] = ((fmt >> k) & 1) === 1;
    m[7][8] = ((fmt >> 6) & 1) === 1;
    m[8][8] = ((fmt >> 7) & 1) === 1;
    m[8][7] = ((fmt >> 8) & 1) === 1;
    for (k = 9; k < 15; k++) m[8][14 - k] = ((fmt >> k) & 1) === 1;

    // 第二份副本
    for (k = 0; k < 8; k++) m[8][size - 1 - k] = ((fmt >> k) & 1) === 1;
    for (k = 8; k < 15; k++) m[size - 15 + k][8] = ((fmt >> k) & 1) === 1;

    // 固定暗模块（dark module）
    m[size - 8][8] = true;

    /* 数据放置（自右下角开始，两列一组，蛇形向上/向下） */
    var inc = -1, row = size - 1, bitIndex = 7, byteIndex = 0;
    for (var col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--;  // 跳过时序列
      for (;;) {
        for (var q = 0; q < 2; q++) {
          if (m[row][col - q] === null) {
            var dark = false;
            if (byteIndex < allBytes.length) {
              dark = ((allBytes[byteIndex] >>> bitIndex) & 1) === 1;
            }
            if (maskFn(mask, row, col - q)) dark = !dark;
            m[row][col - q] = dark;
            bitIndex--;
            if (bitIndex === -1) { byteIndex++; bitIndex = 7; }
          }
        }
        row += inc;
        if (row < 0 || row >= size) { row -= inc; inc = -inc; break; }
      }
    }
    return m;
  }

  /* ---------- 对外 ---------- */
  function create(text) {
    var bytes = utf8Bytes(String(text));
    var version = null;
    for (var v = 1; v <= 5; v++) {
      if (4 + 8 + bytes.length * 8 <= VER[v].data * 8) { version = v; break; }
    }
    if (!version) throw new Error('内容过长（最多约 ' + (VER[5].data - 2) + ' 字节）');
    var dataWords = toDataCodewords(bytes, version);
    var ec = ecCodewords(dataWords, VER[version].ec);
    return makeMatrix(version, dataWords.concat(ec));
  }

  global.QRCodeGen = { create: create };
})(window);