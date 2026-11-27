/* ============================================================
 * qr-print-common.js —— 通用二维码标签渲染与打印服务
 * 复用自 editor-qr.js 的批量打印实现，抽成无 DOM/数据依赖的公共服务：
 *   - 只用 QRCodeGen.create(gid) + 传入的文字行，不碰 gridData/currentId
 *   - 打印：隐藏 iframe + @page(mm) + window.print()
 * 对外：window.QrCardService
 * ============================================================ */
(function () {
  'use strict';

  var QR_TEMPLATE_KEY = 'ledger_qr_template_v1';
  var BP_KEY = 'ledger_batch_print_v1';

  function defaultTemplate() {
    return {
      columns: [], textPosition: 'bottom', showHeader: true,
      qrScale: 10, quietZone: 4, fontSize: 20, margin: 24, gap: 16
    };
  }
  function loadTemplate() {
    try {
      var s = localStorage.getItem(QR_TEMPLATE_KEY);
      if (s) {
        var t = JSON.parse(s), d = defaultTemplate();
        for (var k in d) if (t && t[k] != null) d[k] = t[k];
        return d;
      }
    } catch (e) {}
    return defaultTemplate();
  }
  function saveTemplate(t) {
    try { localStorage.setItem(QR_TEMPLATE_KEY, JSON.stringify(t)); } catch (e) {}
  }

  /* 常用纸张尺寸表（mm，宽 x 高，纵向）—— 与批量打印一致 */
  var PAPER_SIZES = [
    { id: 'A0', w: 841, h: 1189 }, { id: 'A1', w: 594, h: 841 },
    { id: 'A2', w: 420, h: 594 },  { id: 'A3', w: 297, h: 420 },
    { id: 'A4', w: 210, h: 297 },  { id: 'A5', w: 148, h: 210 },
    { id: 'A6', w: 105, h: 148 },
    { id: 'B0', w: 1000, h: 1414 }, { id: 'B1', w: 707, h: 1000 },
    { id: 'B2', w: 500, h: 707 },  { id: 'B3', w: 353, h: 500 },
    { id: 'B4', w: 250, h: 353 },  { id: 'B5', w: 176, h: 250 },
    { id: 'B6', w: 125, h: 176 },
    { id: 'Letter', w: 216, h: 279 }, { id: 'Legal', w: 216, h: 356 },
    { id: 'Tabloid', w: 279, h: 432 }, { id: 'Ledger', w: 432, h: 279 }
  ];
  function defaultPrintCfg() {
    return { title: '', columns: [], paper: 'A4', paperW: 210, paperH: 297,
             labelPreset: '40x30', labelW: 40, labelH: 30 };
  }
  function loadPrintCfg() {
    var d = defaultPrintCfg();
    try {
      var s = localStorage.getItem(BP_KEY);
      if (s) { var c = JSON.parse(s); for (var k in d) if (c && c[k] != null) d[k] = c[k]; }
    } catch (e) {}
    return d;
  }
  function savePrintCfg(c) {
    try { localStorage.setItem(BP_KEY, JSON.stringify(c)); } catch (e) {}
  }
  function paperById(id) {
    for (var i = 0; i < PAPER_SIZES.length; i++) if (PAPER_SIZES[i].id === id) return PAPER_SIZES[i];
    return null;
  }
  function effectivePaper(cfg) {
    if (cfg.paper === 'custom') {
      return { w: Math.max(20, Number(cfg.paperW) || 210), h: Math.max(20, Number(cfg.paperH) || 297) };
    }
    var p = paperById(cfg.paper) || paperById('A4');
    return { w: p.w, h: p.h };
  }
  function effectiveLabel(cfg) {
    if (cfg.labelPreset === 'custom') {
      return { w: Math.max(10, Number(cfg.labelW) || 40), h: Math.max(10, Number(cfg.labelH) || 30) };
    }
    var parts = String(cfg.labelPreset || '40x30').split('x');
    return { w: Number(parts[0]) || 40, h: Number(parts[1]) || 30 };
  }
  function printTemplate(cfg) {
    var t = defaultTemplate();
    t.columns = [];
    t.showHeader = true; t.textPosition = 'bottom';
    t.qrScale = 8; t.quietZone = 3; t.fontSize = 22; t.margin = 18; t.gap = 10;
    return t;
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
    });
  }

  function canvasToBlob(canvas) {
    return new Promise(function (resolve) {
      if (canvas.toBlob) canvas.toBlob(function (b) { resolve(b); }, 'image/png');
      else {
        var url = canvas.toDataURL('image/png');
        var bin = atob(url.split(',')[1]);
        var arr = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        resolve(new Blob([arr], { type: 'image/png' }));
      }
    });
  }

  /* 矩阵 + 文字行 → 卡片 PNG Blob（复用原 matrixToCardBlob） */
  function cardBlob(matrix, tpl, lines) {
    var n = matrix.length;
    var scale = Math.max(1, parseInt(tpl.qrScale, 10) || 10);
    var quiet = Math.max(0, parseInt(tpl.quietZone, 10) || 0);
    var fontSize = Math.max(8, parseInt(tpl.fontSize, 10) || 20);
    var margin = Math.max(0, parseInt(tpl.margin, 10) || 24);
    var gap = lines.length ? Math.max(0, parseInt(tpl.gap, 10) || 16) : 0;
    var qrSize = (n + quiet * 2) * scale;
    var lineHeight = Math.round(fontSize * 1.35);
    var textH = lines.length * lineHeight;

    var probe = document.createElement('canvas').getContext('2d');
    var fontStr = 'bold ' + fontSize + 'px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
    probe.font = fontStr;
    var maxTextW = 0;
    lines.forEach(function (ln) {
      var w = probe.measureText(ln).width;
      if (w > maxTextW) maxTextW = w;
    });

    var width = Math.ceil(Math.max(qrSize, maxTextW) + margin * 2);
    var height = Math.ceil(qrSize + gap + textH + margin * 2);
    var canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#000000';

    var qrX = Math.round((width - qrSize) / 2);
    var qrY = margin;
    if (tpl.textPosition === 'top' && lines.length) qrY = margin + textH + gap;
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) {
        if (matrix[r][c]) ctx.fillRect(qrX + (c + quiet) * scale, qrY + (r + quiet) * scale, scale, scale);
      }
    }
    if (lines.length) {
      ctx.font = fontStr; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      var textY = (tpl.textPosition === 'top') ? margin : (qrY + qrSize + gap);
      lines.forEach(function (ln, i) { ctx.fillText(ln, width / 2, textY + i * lineHeight); });
    }
    return canvasToBlob(canvas);
  }

  /* 生成一张卡片：gid + 文字行 + 模板 */
  async function renderCard(gid, lines, tplOverride) {
    if (typeof window.QRCodeGen === 'undefined') throw new Error('二维码组件未加载');
    var tpl = tplOverride || loadTemplate();
    var matrix = window.QRCodeGen.create(gid);
    return await cardBlob(matrix, tpl, lines || []);
  }

  function blobToDataURL(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(new Error('图片读取失败')); };
      fr.readAsDataURL(blob);
    });
  }

  /* 生成打印 HTML：cards = [{dataUrl, title}]，按纸张/标签 mm 排布并分页 */
  function buildPrintHtml(cards, cfg) {
    var paper = effectivePaper(cfg);
    var lab = effectiveLabel(cfg);
    var margin = 5, gap = 2;
    var colsPerPage = Math.max(1, Math.floor((paper.w - margin * 2 + gap) / (lab.w + gap)));
    var rowsPerPage = Math.max(1, Math.floor((paper.h - margin * 2 + gap) / (lab.h + gap)));
    var perPage = colsPerPage * rowsPerPage;

    var pages = [];
    for (var p = 0; p < cards.length; p += perPage) {
      var chunk = cards.slice(p, p + perPage);
      var cells = chunk.map(function (c) {
        var titleHtml = c.title ? '<div class="lbl-title">' + escapeHtml(c.title) + '</div>' : '';
        return '<div class="lbl">' + titleHtml +
               '<img class="lbl-img" src="' + c.dataUrl + '"></div>';
      }).join('');
      pages.push('<div class="sheet"><div class="sheet-grid">' + cells + '</div></div>');
    }
    var titleFont = Math.max(8, Math.min(16, lab.w * 0.32));
    var css = '@page { size: ' + paper.w + 'mm ' + paper.h + 'mm; margin: 0; }' +
      'html,body { margin:0; padding:0; }' +
      '.sheet { width:' + paper.w + 'mm; height:' + paper.h + 'mm; box-sizing:border-box;' +
      ' padding:' + margin + 'mm; page-break-after:always; break-after:page; overflow:hidden; }' +
      '.sheet:last-child { page-break-after:auto; break-after:auto; }' +
      '.sheet-grid { display:grid; grid-template-columns:repeat(' + colsPerPage + ',' + lab.w + 'mm);' +
      ' grid-auto-rows:' + lab.h + 'mm; gap:' + gap + 'mm; }' +
      '.lbl { width:' + lab.w + 'mm; height:' + lab.h + 'mm; box-sizing:border-box;' +
      ' display:flex; flex-direction:column; align-items:center; justify-content:center;' +
      ' overflow:hidden; page-break-inside:avoid; break-inside:avoid; }' +
      '.lbl-title { font-weight:700; font-size:' + titleFont + 'pt; line-height:1.1;' +
      ' text-align:center; word-break:break-all; margin-bottom:1mm; }' +
      '.lbl-img { max-width:100%; max-height:100%; object-fit:contain; }';
    return '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' + css +
           '</style></head><body>' + pages.join('') + '</body></html>';
  }

  /* 唤起浏览器打印（隐藏 iframe，打印后清理） */
  function printHtml(html, onError) {
    var iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
    iframe.setAttribute('aria-hidden', 'true');
    document.body.appendChild(iframe);
    var doc = iframe.contentWindow.document;
    doc.open(); doc.write(html); doc.close();
    var cleanup = function () {
      setTimeout(function () { if (iframe.parentNode) iframe.parentNode.removeChild(iframe); }, 1000);
    };
    var printNow = function () {
      try { iframe.contentWindow.focus(); iframe.contentWindow.print(); }
      catch (e) { if (onError) onError(e); }
      cleanup();
    };
    if (doc.readyState === 'complete') printNow();
    else iframe.contentWindow.addEventListener('load', printNow, { once: true });
  }

  window.QrCardService = {
    PAPER_SIZES: PAPER_SIZES,
    defaultTemplate: defaultTemplate,
    loadTemplate: loadTemplate,
    saveTemplate: saveTemplate,
    defaultPrintCfg: defaultPrintCfg,
    loadPrintCfg: loadPrintCfg,
    savePrintCfg: savePrintCfg,
    paperById: paperById,
    effectivePaper: effectivePaper,
    effectiveLabel: effectiveLabel,
    printTemplate: printTemplate,
    renderCard: renderCard,
    blobToDataURL: blobToDataURL,
    buildPrintHtml: buildPrintHtml,
    printHtml: printHtml
  };
})();
