/* ============================================================
 * editor-loc.js —— 位置格（SVG 布局图）渲染与下载
 * 【内嵌方案】data[r][0] 是 uuid，位置列索引从 1 开始
 * ============================================================ */

function incLabel(start, n) {
  if (!start) return String(n + 1);
  if (/^[a-zA-Z]$/.test(start)) {
    var code = start.toUpperCase().charCodeAt(0);
    var c2 = code + n;
    if (c2 > 90) c2 = ((c2 - 65) % 26) + 65;
    return String.fromCharCode(c2);
  }
  if (/^\d+$/.test(start)) {
    var base = parseInt(start, 10);
    var v = String(base + n);
    while (v.length < start.length) v = '0' + v;
    return v;
  }
  return start + n;
}

function buildLocSVG(rows, cols, positions, posMap) {
  var CELL_W = 110, CELL_H = 80, GAP = 8, PAD = 16;
  var width = PAD * 2 + cols * CELL_W + (cols - 1) * GAP;
  var height = PAD * 2 + rows * CELL_H + (rows - 1) * GAP;
  var FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', 'PingFang SC', 'Helvetica Neue', Arial, sans-serif";
  var out = [];
  out.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height +
           '" viewBox="0 0 ' + width + ' ' + height + '" font-family="' + FONT + '">');
  out.push('<defs>');
  out.push('<linearGradient id="occGrad_' + uuidHex().slice(0, 8) + '" x1="0" y1="0" x2="1" y2="1">');
  out.push('<stop offset="0%" stop-color="#818cf8"/>');
  out.push('<stop offset="100%" stop-color="#6366f1"/>');
  out.push('</linearGradient>');
  out.push('</defs>');
  out.push('<rect x="0" y="0" width="' + width + '" height="' + height + '" fill="#ffffff"/>');
  positions.forEach(function (p) {
    var key = p.name.toUpperCase();
    var data = posMap[key];
    var x = PAD + p.col * (CELL_W + GAP);
    var y = PAD + p.row * (CELL_H + GAP);
    var fill = data ? '#6366f1' : '#f8fafc';
    var stroke = data ? '#6366f1' : '#e2e8f0';
    var posFill = data ? 'rgba(255,255,255,0.85)' : '#94a3b8';
    var infoFill = data ? '#ffffff' : '#64748b';
    var infoWeight = data ? '500' : '400';
    var rectAttrs = 'x="' + x + '" y="' + y + '" width="' + CELL_W + '" height="' + CELL_H +
                    '" rx="8" ry="8" fill="' + fill + '" stroke="' + stroke + '" stroke-width="1"';
    if (data && data.rows.length > 0) {
      rectAttrs += ' class="clickable" data-rows="' + data.rows.join(',') + '"';
    }
    out.push('<rect ' + rectAttrs + '/>');
    out.push('<text x="' + (x + 10) + '" y="' + (y + 18) +
             '" font-size="11" font-weight="600" fill="' + posFill +
             '" letter-spacing="0.5">' + escXml(p.name) + '</text>');
    var info;
    if (data) {
      if (data.labels.length > 0) {
        info = (data.labels.length === 1) ? data.labels[0] : (data.labels.length + ' 台设备');
      } else {
        info = (data.count === 1) ? '已使用' : (data.count + ' 条');
      }
    } else { info = '空'; }
    info = truncateStr(info, 10);
    out.push('<text x="' + (x + 10) + '" y="' + (y + 46) +
             '" font-size="12" font-weight="' + infoWeight + '" fill="' + infoFill +
             '">' + escXml(info) + '</text>');
  });
  out.push('</svg>');
  return { svg: out.join(''), width: width, height: height };
}

function renderLocationGrid() {
  if (currentId === null) { alert('请先打开或新建一本台账'); return; }
  if (!gridData.length || !gridData[0].length) { alert('当前台账没有表头，无法生成位置图'); return; }
  var rows = parseInt($('locRows').value, 10) || 3;
  var cols = parseInt($('locCols').value, 10) || 6;
  rows = Math.max(1, Math.min(rows, 200));
  cols = Math.max(1, Math.min(cols, 200));
  $('locRows').value = rows; $('locCols').value = cols;
  var rowStart = ($('locRowStart').value || 'A').trim();
  var colStart = ($('locColStart').value || '1').trim();
  var sep = ($('locSep').value || '').trim();
  var posColIdx = parseInt($('locCol').value, 10);
  if (isNaN(posColIdx) || posColIdx < 1) { alert('请选择位置列'); return; }
  if (isTimeColumn(posColIdx)) { alert('不能选择更新时间列作为位置列'); return; }
  var labelVal = $('locLabelCol').value;
  var labelIdx = labelVal === '' ? -1 : parseInt(labelVal, 10);
  if (labelIdx >= 0 && isTimeColumn(labelIdx)) { alert('不能选择更新时间列作为标签列'); return; }
  var positions = []; var posIndexMap = {};
  for (var r = 0; r < rows; r++) {
    var rl = incLabel(rowStart, r);
    for (var c = 0; c < cols; c++) {
      var cl = incLabel(colStart, c);
      var name = rl + sep + cl;
      var p = { row: r, col: c, name: name };
      positions.push(p); posIndexMap[name.toUpperCase()] = p;
    }
  }
  var posMap = {}; var unmatched = [];
  for (var i = 1; i < gridData.length; i++) {
    var raw = String(getCell(i, posColIdx) || '').trim();
    if (!raw) continue;
    var key = raw.toUpperCase();
    if (!posIndexMap[key]) {
      if (unmatched.indexOf(raw) === -1) unmatched.push(raw);
      continue;
    }
    if (!posMap[key]) posMap[key] = { count: 0, labels: [], raws: [], rows: [] };
    posMap[key].count++; posMap[key].raws.push(raw); posMap[key].rows.push(i);
    if (labelIdx >= 0) {
      var lb = String(getCell(i, labelIdx) || '').trim();
      if (lb) posMap[key].labels.push(lb);
    }
  }
  var info = buildLocSVG(rows, cols, positions, posMap);
  locSvgString = info.svg; locSvgSize = { w: info.width, h: info.height };
  $('locGrid').innerHTML = info.svg;
  var hint = $('locHint');
  var total = rows * cols;
  var occupied = Object.keys(posMap).length;
  var text = '已使用：' + occupied + ' / ' + total + ' 个位置';
  var isWarn = false;
  if (unmatched.length > 0) {
    isWarn = true;
    var sample = unmatched.slice(0, 20).join('、');
    if (unmatched.length > 20) sample += ' …';
    text += '\n⚠ 以下位置值不在当前网格范围内，未绘制：' + sample;
    text += '\n（可检查行数/列数/起始标签/分隔符是否与台账数据一致）';
  }
  hint.textContent = text;
  hint.classList.toggle('warn', isWarn);
  hint.classList.remove('hidden');
  $('locActions').classList.remove('hidden');
}

function downloadLocSVG() {
  if (!locSvgString) { alert('请先生成位置图'); return; }
  var xml = '<?xml version="1.0" encoding="UTF-8"?>\n' + locSvgString;
  var blob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = cleanFileName(currentLedger ? currentLedger.name : '位置图') + '.svg';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
}

function downloadLocPNG() {
  if (!locSvgString) { alert('请先生成位置图'); return; }
  var scale = 2;
  var w = locSvgSize.w, h = locSvgSize.h;
  if (!w || !h) { alert('位置图尺寸异常'); return; }
  var blob = new Blob([locSvgString], { type: 'image/svg+xml;charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var img = new Image();
  img.onload = function () {
    try {
      var canvas = document.createElement('canvas');
      canvas.width = w * scale; canvas.height = h * scale;
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(function (blob2) {
        URL.revokeObjectURL(url);
        if (!blob2) { alert('PNG 生成失败，请改用 SVG'); return; }
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob2);
        a.download = cleanFileName(currentLedger ? currentLedger.name : '位置图') + '.png';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 1500);
      }, 'image/png');
    } catch (e) {
      URL.revokeObjectURL(url);
      alert('PNG 生成失败：' + e.message + '\n请改用 SVG 下载');
    }
  };
  img.onerror = function () {
    URL.revokeObjectURL(url);
    alert('PNG 生成失败：SVG 渲染出错，请改用 SVG 下载');
  };
  img.src = url;
}