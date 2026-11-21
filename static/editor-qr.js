/* ============================================================
 * editor-qr.js —— 每行生成二维码并保存到台账附件库
 *   - 内容：行唯一标识 L{lid}_{row_uuid}
 *   - 文件名：data[1]（该行第一列的值），重名时询问是否覆盖
 *   - ★ 新增：表头「全部」按钮 → 一键批量生成
 * ============================================================ */
(function () {
  'use strict';

  /* ============================================================
     ★ 二维码统一模板：无论「上传到附件库」还是「浏览器内预览」，
       都走同一套 renderQrCard() 生成图片（二维码 + 可选附加列文字）。
     ============================================================ */
  var QR_TEMPLATE_KEY = 'ledger_qr_template_v1';

  function defaultQrTemplate() {
    return {
      columns: [],           // 附加列 UUID 列表
      textPosition: 'bottom', // 'top' | 'bottom'
      showHeader: true,      // 显示「列名：值」
      qrScale: 10,           // 二维码模块像素
      quietZone: 4,          // 静区模块数
      fontSize: 20,          // 附加文字字号
      margin: 24,            // 外边框留白
      gap: 16                // 二维码与文字间距
    };
  }
  function loadQrTemplate() {
    try {
      var s = localStorage.getItem(QR_TEMPLATE_KEY);
      if (s) {
        var t = JSON.parse(s);
        var d = defaultQrTemplate();
        for (var k in d) if (t && t[k] != null) d[k] = t[k];
        return d;
      }
    } catch (e) {}
    return defaultQrTemplate();
  }
  function saveQrTemplate(t) {
    try { localStorage.setItem(QR_TEMPLATE_KEY, JSON.stringify(t)); } catch (e) {}
  }

  /* 画布 → PNG Blob */
  function canvasToBlob(canvas) {
    return new Promise(function (resolve) {
      if (canvas.toBlob) {
        canvas.toBlob(function (b) { resolve(b); }, 'image/png');
      } else {
        var url = canvas.toDataURL('image/png');
        var bin = atob(url.split(',')[1]);
        var arr = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        resolve(new Blob([arr], { type: 'image/png' }));
      }
    });
  }

  /* 从模板选中的列提取文字行 */
  function collectQrLines(rowIdx, tpl) {
    var lines = [];
    var row = gridData[rowIdx];
    if (!row || !gridData[0]) return lines;
    var tcol = typeof findTimeColumn === 'function' ? findTimeColumn() : -1;
    var idToIdx = {};
    for (var c = 1; c < gridData[0].length; c++) {
      var cid = getColumnIdAt(c);
      if (cid && !idToIdx[cid]) idToIdx[cid] = c;
    }
    (tpl.columns || []).forEach(function (colId) {
      var c = idToIdx[colId];
      if (!c || c === tcol) return;
      var header = String(gridData[0][c] == null ? '' : gridData[0][c]).trim();
      var value = String(row[c] == null ? '' : row[c]).trim();
      if (!value) return;                     // 空值不打印
      lines.push((tpl.showHeader && header) ? (header + '：' + value) : value);
    });
    return lines;
  }

  /* 矩阵 + 模板文字 → 卡片 PNG Blob */
  function matrixToCardBlob(matrix, tpl, lines) {
    var n = matrix.length;
    var scale = Math.max(1, parseInt(tpl.qrScale, 10) || 10);
    var quiet = Math.max(0, parseInt(tpl.quietZone, 10) || 0);
    var fontSize = Math.max(8, parseInt(tpl.fontSize, 10) || 20);
    var margin = Math.max(0, parseInt(tpl.margin, 10) || 24);
    var gap = lines.length ? Math.max(0, parseInt(tpl.gap, 10) || 16) : 0;
    var qrSize = (n + quiet * 2) * scale;
    var lineHeight = Math.round(fontSize * 1.35);
    var textH = lines.length * lineHeight;

    // 测文本宽度
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
    canvas.width = width;
    canvas.height = height;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#000000';

    // 二维码位置（文字在上时整体下移）
    var qrX = Math.round((width - qrSize) / 2);
    var qrY = margin;
    if (tpl.textPosition === 'top' && lines.length) qrY = margin + textH + gap;
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) {
        if (matrix[r][c]) {
          ctx.fillRect(qrX + (c + quiet) * scale, qrY + (r + quiet) * scale, scale, scale);
        }
      }
    }

    // 附加文字
    if (lines.length) {
      ctx.font = fontStr;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      var textY = (tpl.textPosition === 'top') ? margin : (qrY + qrSize + gap);
      lines.forEach(function (ln, i) {
        ctx.fillText(ln, width / 2, textY + i * lineHeight);
      });
    }

    return canvasToBlob(canvas);
  }

  /* 统一生成入口：gid + 行号 → 卡片 PNG Blob
   * tplOverride：可选，传入则覆盖二维码模板（批量打印会传入所选字段的模板） */
  async function renderQrCard(gid, rowIdx, tplOverride) {
    var tpl = tplOverride || loadQrTemplate();
    var matrix = window.QRCodeGen.create(gid);
    var lines = collectQrLines(rowIdx, tpl);
    return await matrixToCardBlob(matrix, tpl, lines);
  }

  /* 清理文件名（保留可读，去掉非法字符） */
  function sanitizeName(raw, fallback) {
    var s = String(raw == null ? '' : raw)
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
    return s || fallback;
  }

  /* 上传（multipart，不能走 editor-core 的 api()，它会强制 JSON 头）
   * ★ onError: 可选回调。传了就走回调（不弹 alert），没传就按原逻辑 alert。
   *   批量生成时用它收集错误，避免连续弹窗。 */
  async function uploadPng(blob, filename, onError) {
    var fd = new FormData();
    fd.append('file', blob, filename);
    var res;
    try {
      res = await fetch('/api/ledgers/' + currentId + '/files', {
        method: 'POST',
        headers: { 'X-CSRF-Token': CSRF },
        body: fd
      });
    } catch (e) {
      var em = '上传失败：' + e.message;
      if (typeof onError === 'function') onError(em); else alert(em);
      return false;
    }
    if (res.status === 401) { window.location.href = '/'; return false; }
    var data = {};
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) {
      var msg = data.msg || ('上传失败：' + res.status);
      if (typeof onError === 'function') onError(msg); else alert(msg);
      return false;
    }
    return true;
  }

  /* 刷新附件抽屉（若已加载） */
  function refreshFileManager() {
    if (window.FileManager && typeof window.FileManager.refresh === 'function') {
      try {
        var p = window.FileManager.refresh();
        if (p && typeof p.catch === 'function') p.catch(function () {});
      } catch (e) {}
    }
  }

  /* ---------- 浏览器内预览二维码（无 file.upload 权限时使用） ---------- */
  var qrPreviewUrls = [];

  function showQrPreview(items) {
    var modal = document.getElementById('qrPreviewModal');
    var list = document.getElementById('qrPreviewList');
    if (!modal || !list) return;

    qrPreviewUrls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) {} });
    qrPreviewUrls = [];

    list.innerHTML = '';
    if (!items.length) {
      list.innerHTML = '<div class="qr-preview-empty">没有可生成的二维码</div>';
    }
    items.forEach(function (it) {
      var url = URL.createObjectURL(it.blob);
      qrPreviewUrls.push(url);

      var wrap = document.createElement('div');
      wrap.className = 'qr-preview-item';

      var img = document.createElement('img');
      img.className = 'qr-preview-img';
      img.src = url;
      img.alt = it.filename;

      var name = document.createElement('div');
      name.className = 'qr-preview-name';
      name.textContent = it.filename;

      var gid = document.createElement('div');
      gid.className = 'qr-preview-gid';
      gid.textContent = it.gid;

      var dl = document.createElement('a');
      dl.className = 'qr-preview-dl';
      dl.href = url;
      dl.download = it.filename;
      dl.textContent = '下载 PNG';

      wrap.appendChild(img);
      wrap.appendChild(name);
      wrap.appendChild(gid);
      wrap.appendChild(dl);
      list.appendChild(wrap);
    });

    modal.classList.remove('hidden');
  }

  async function generateAllQRCodesPreview(btn) {
    var totalRows = gridData.length - 1;
    var items = [];
    var usedNames = {};

    for (var row = 1; row < gridData.length; row++) {
      if (btn) btn.textContent = row + '/' + totalRows;
      var rowData = gridData[row];
      if (!rowData) continue;
      var rowUuid = rowData[0];
      if (!rowUuid || rowUuid === UUID_SENTINEL) continue;

      var gid = 'L' + currentId + '_' + rowUuid;
      var baseName = sanitizeName(rowData[1], gid);
      var filename = baseName + '.png';
      if (usedNames[filename]) continue;
      usedNames[filename] = true;

      var blob;
      try {
        blob = await renderQrCard(gid, row);
      } catch (e) {
        continue;
      }
      if (!blob) continue;

      items.push({ filename: filename, gid: gid, blob: blob });
    }

    if (btn) btn.textContent = '全部';
    showQrPreview(items);
  }

  function bindQrPreviewClose() {
    var modal = document.getElementById('qrPreviewModal');
    if (!modal || modal._qrPreviewBound) return;
    modal._qrPreviewBound = true;
    var closeBtn = document.getElementById('qrPreviewClose');
    if (closeBtn) {
      closeBtn.addEventListener('click', function () {
        modal.classList.add('hidden');
      });
    }
    modal.addEventListener('click', function (e) {
      if (e.target === modal) modal.classList.add('hidden');
    });
  }

  /* ---------- 二维码模板设置弹窗 ---------- */
  function clampInt(v, min, max, def) {
    var n = parseInt(v, 10);
    if (isNaN(n)) return def;
    return Math.max(min, Math.min(max, n));
  }

  function openQrTemplateModal() {
    if (!currentLedger) { alert('请先打开一本台账'); return; }
    var modal = document.getElementById('qrTemplateModal');
    if (!modal) return;
    var tpl = loadQrTemplate();
    var tcol = typeof findTimeColumn === 'function' ? findTimeColumn() : -1;

    var colsHost = document.getElementById('qrTemplateCols');
    colsHost.innerHTML = '';
    if (!gridData[0] || gridData[0].length <= 1) {
      colsHost.innerHTML = '<div class="qr-template-hint">当前台账没有可附加的数据列</div>';
    } else {
      for (var c = 1; c < gridData[0].length; c++) {
        if (c === tcol) continue;                 // 更新时间列不参与
        var colId = getColumnIdAt(c);
        var header = String(gridData[0][c] == null ? '' : gridData[0][c]).trim() || ('列' + c);
        var label = document.createElement('label');
        label.className = 'qr-template-col';
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = colId;
        cb.checked = (tpl.columns || []).indexOf(colId) >= 0;
        var span = document.createElement('span');
        span.textContent = header;
        label.appendChild(cb);
        label.appendChild(span);
        colsHost.appendChild(label);
      }
    }

    document.getElementById('qrTemplatePos').value = tpl.textPosition || 'bottom';
    document.getElementById('qrTemplateShowHeader').checked = !!tpl.showHeader;
    document.getElementById('qrTemplateScale').value = tpl.qrScale;
    document.getElementById('qrTemplateQuiet').value = tpl.quietZone;
    document.getElementById('qrTemplateFont').value = tpl.fontSize;
    document.getElementById('qrTemplateMargin').value = tpl.margin;
    document.getElementById('qrTemplateGap').value = tpl.gap;

    modal.classList.remove('hidden');
  }

  function saveQrTemplateFromModal() {
    var tpl = defaultQrTemplate();
    var cols = [];
    Array.prototype.forEach.call(
      document.querySelectorAll('#qrTemplateCols input[type="checkbox"]'),
      function (cb) { if (cb.checked) cols.push(cb.value); }
    );
    tpl.columns = cols;
    tpl.textPosition = document.getElementById('qrTemplatePos').value;
    tpl.showHeader = !!document.getElementById('qrTemplateShowHeader').checked;
    tpl.qrScale = clampInt(document.getElementById('qrTemplateScale').value, 1, 20, 10);
    tpl.quietZone = clampInt(document.getElementById('qrTemplateQuiet').value, 0, 8, 4);
    tpl.fontSize = clampInt(document.getElementById('qrTemplateFont').value, 8, 48, 20);
    tpl.margin = clampInt(document.getElementById('qrTemplateMargin').value, 0, 80, 24);
    tpl.gap = clampInt(document.getElementById('qrTemplateGap').value, 0, 40, 16);
    saveQrTemplate(tpl);
    document.getElementById('qrTemplateModal').classList.add('hidden');
    showActionToast('✓ 二维码模板已保存', 'success');
  }

  function bindQrTemplateModal() {
    var modal = document.getElementById('qrTemplateModal');
    if (!modal || modal._qrTemplateBound) return;
    modal._qrTemplateBound = true;
    var closeBtn = document.getElementById('qrTemplateClose');
    if (closeBtn) {
      closeBtn.addEventListener('click', function () { modal.classList.add('hidden'); });
    }
    var cancelBtn = document.getElementById('qrTemplateCancel');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', function () { modal.classList.add('hidden'); });
    }
    var saveBtn = document.getElementById('qrTemplateSave');
    if (saveBtn) saveBtn.addEventListener('click', saveQrTemplateFromModal);
    modal.addEventListener('click', function (e) {
      if (e.target === modal) modal.classList.add('hidden');
    });
  }

  function bindGridQrSettingsClick() {
    var grid = document.getElementById('grid');
    if (!grid) return;
    if (grid._qrSettingsBound) return;
    grid._qrSettingsBound = true;
    grid.addEventListener('click', function (e) {
      var btn = e.target.closest('.qr-settings-btn');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      openQrTemplateModal();
    }, true);
  }

  /* ---------- 单行生成 ---------- */
  async function generateRowQRCode(row) {
    if (!currentLedger) { alert('请先打开一本台账'); return; }
    if (!myPermissions['qr.generate']) { alert('没有生成二维码的权限'); return; }

    var rowData = gridData[row];
    if (!rowData) return;
    var rowUuid = rowData[0];
    if (!rowUuid || rowUuid === UUID_SENTINEL) {
      alert('该行缺少唯一标识，请刷新页面后重试');
      return;
    }

    /* 1) 内容 = 行唯一标识（与扫码 API 一致） */
    var gid = 'L' + currentId + '_' + rowUuid;

    /* 2) 文件名 = data[1] */
    var baseName = sanitizeName(rowData[1], gid);
    var filename = baseName + '.png';

    /* 3) 生成 PNG（统一模板） */
    if (typeof window.QRCodeGen === 'undefined') {
      alert('二维码组件未加载，请刷新页面');
      return;
    }
    var blob;
    try {
      blob = await renderQrCard(gid, row);
    } catch (e) {
      alert('二维码生成失败：' + (e && e.message ? e.message : e));
      return;
    }
    if (!blob) { alert('二维码图片生成失败'); return; }

    /* 没有附件上传权限 → 只在浏览器内展示，不入附件库 */
    if (!myPermissions['file.upload']) {
      showQrPreview([{ filename: filename, gid: gid, blob: blob }]);
      return;
    }

    /* 4) 同名文件检查 */
    var existing = [];
    try {
      var list = await api('/api/ledgers/' + currentId + '/files');
      existing = (list.files || []).filter(function (f) { return f.filename === filename; });
    } catch (e) {
      alert('读取附件列表失败：' + (e.message || e));
      return;
    }

    if (existing.length) {
      var noPerm = existing.filter(function (f) { return !f.can_delete; });
      if (noPerm.length) {
        alert('附件库中已存在同名文件「' + filename + '」，\n' +
              '但你没有删除权限（只有 root 或上传者本人可删除）。\n' +
              '请修改该行第一列的内容，或手动删除旧附件后重试。');
        return;
      }
      if (!confirm('附件库中已存在「' + filename + '」，是否用新二维码覆盖？')) return;
      for (var i = 0; i < existing.length; i++) {
        try {
          await api('/api/files/' + existing[i].id, { method: 'DELETE' });
        } catch (e) {
          alert('删除旧附件失败：' + (e.message || e));
          return;
        }
      }
    }

    /* 5) 上传 */
    var ok = await uploadPng(blob, filename);
    if (!ok) return;

    /* 6) 提示（含 gid，方便核对内容） */
    showActionToast('✓ 二维码已保存：' + filename + '\n内容：' + gid, 'success');
    console.log('[QR] 已生成并保存：', filename, '\n  gid =', gid);

    /* 7) 刷新附件抽屉 */
    refreshFileManager();
  }

  /* ---------- ★ 一键批量生成 ---------- */
  async function generateAllQRCodes() {
    if (!currentLedger) { alert('请先打开一本台账'); return; }
    if (!myPermissions['qr.generate']) { alert('没有生成二维码的权限'); return; }
    if (typeof window.QRCodeGen === 'undefined') {
      alert('二维码组件未加载，请刷新页面');
      return;
    }

    var totalRows = gridData.length - 1;
    if (totalRows <= 0) { alert('当前台账没有数据行'); return; }

    var btn = document.querySelector('.qr-all-btn');

    /* 没有附件上传权限 → 只在浏览器内生成并展示，不入附件库 */
    if (!myPermissions['file.upload']) {
      await generateAllQRCodesPreview(btn);
      return;
    }

    if (!confirm(
        '确定要为全部 ' + totalRows + ' 行生成二维码吗？\n\n' +
        '· 二维码内容 = 行唯一标识（L{lid}_{uuid}）\n' +
        '· 文件名取每行第一列的值\n' +
        '· 附件库中已存在同名文件且你有删除权限时，自动覆盖\n' +
        '· 若两行第一列内容相同，后面的会被跳过（避免互相覆盖）'
    )) return;

    /* 一次性读取附件列表，避免每行都请求 */
    var existingFiles = [];
    try {
      var list = await api('/api/ledgers/' + currentId + '/files');
      existingFiles = list.files || [];
    } catch (e) {
      alert('读取附件列表失败：' + (e.message || e));
      if (btn) btn.textContent = '全部';
      return;
    }

    /* 文件名 → 文件列表 */
    var fileIndex = {};
    existingFiles.forEach(function (f) {
      if (!fileIndex[f.filename]) fileIndex[f.filename] = [];
      fileIndex[f.filename].push(f);
    });
    /* 本批次已用过的文件名（处理"两行第一列重名"） */
    var usedNames = {};

    var okCount = 0, failCount = 0, skipCount = 0;
    var failMsgs = [];

    for (var row = 1; row < gridData.length; row++) {
      var rowData = gridData[row];
      if (!rowData) continue;
      var rowUuid = rowData[0];
      if (!rowUuid || rowUuid === UUID_SENTINEL) {
        failCount++;
        failMsgs.push('第 ' + row + ' 行：缺少唯一标识');
        continue;
      }

      var gid = 'L' + currentId + '_' + rowUuid;
      var baseName = sanitizeName(rowData[1], gid);
      var filename = baseName + '.png';

      /* 进度显示到按钮上 */
      if (btn) btn.textContent = row + '/' + totalRows;

      /* 本批次已用过 → 跳过（两行第一列内容重复） */
      if (usedNames[filename]) {
        skipCount++;
        failMsgs.push('第 ' + row + ' 行：「' + filename + '」与前面某行重名，已跳过');
        continue;
      }

      /* 生成 PNG（统一模板） */
      var blob;
      try {
        blob = await renderQrCard(gid, row);
      } catch (e) {
        failCount++;
        failMsgs.push('第 ' + row + ' 行：二维码生成失败 ' + (e && e.message ? e.message : ''));
        continue;
      }
      if (!blob) {
        failCount++;
        failMsgs.push('第 ' + row + ' 行：PNG 生成失败');
        continue;
      }

      /* 附件库中同名文件 → 检查权限并删除 */
      var existing = fileIndex[filename] || [];
      if (existing.length) {
        var noPerm = existing.filter(function (f) { return !f.can_delete; });
        if (noPerm.length) {
          skipCount++;
          failMsgs.push('第 ' + row + ' 行：「' + filename + '」已存在且无删除权限');
          continue;
        }
        var delFailed = false;
        for (var i = 0; i < existing.length; i++) {
          if (!existing[i].id) continue;
          try {
            await api('/api/files/' + existing[i].id, { method: 'DELETE' });
          } catch (e) {
            delFailed = true;
            failCount++;
            failMsgs.push('第 ' + row + ' 行：删除旧附件失败 ' + (e.message || ''));
            break;
          }
        }
        if (delFailed) continue;
        fileIndex[filename] = [];
      }

      /* 上传（静默模式，不弹 alert） */
      var uploadErrMsg = null;
      var upOk = await uploadPng(blob, filename, function (msg) { uploadErrMsg = msg; });
      if (upOk) {
        okCount++;
        usedNames[filename] = true;
        /* 新上传的加入索引，避免后面若又有同名文件命中"存在"逻辑 */
        fileIndex[filename] = [{ filename: filename, id: null, can_delete: true }];
      } else {
        failCount++;
        failMsgs.push('第 ' + row + ' 行：' + (uploadErrMsg || '上传失败'));
      }
    }

    /* 恢复按钮 */
    if (btn) btn.textContent = '全部';

    /* 汇总 */
    var summary = '✓ 成功 ' + okCount + ' 个';
    if (skipCount) summary += '，⚠ 跳过 ' + skipCount + ' 个';
    if (failCount) summary += '，✕ 失败 ' + failCount + ' 个';
    if (failMsgs.length) {
      summary += '\n\n' + failMsgs.slice(0, 15).join('\n');
      if (failMsgs.length > 15) summary += '\n…（共 ' + failMsgs.length + ' 条错误）';
    }
    alert(summary);

    if (okCount > 0) showActionToast('✓ 二维码批量生成完成', 'success');
    else if (failCount > 0) showActionToast('✕ 二维码批量生成全部失败', 'error');

    /* 刷新附件抽屉 */
    refreshFileManager();
  }

  /* ---------- 单行按钮：捕获阶段拦截，避免触发表格选区逻辑 ---------- */
  function bindGridQrClick() {
    var grid = document.getElementById('grid');
    if (!grid) return;
    if (grid._qrRowBound) return;
    grid._qrRowBound = true;
    grid.addEventListener('click', function (e) {
      var btn = e.target.closest('.row-qr-btn');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      if (btn.dataset.busy === '1') return;
      var row = Number(btn.dataset.row);
      if (!row) return;
      btn.dataset.busy = '1';
      btn.classList.add('qr-busy');
      var done = function () {
        btn.dataset.busy = '0';
        btn.classList.remove('qr-busy');
      };
      generateRowQRCode(row).then(done, function (err) {
        done();
        alert('生成失败：' + (err && err.message ? err.message : err));
      });
    }, true);
  }

  /* ---------- ★ 一键「全部」按钮 ---------- */
  function bindGridQrAllClick() {
    var grid = document.getElementById('grid');
    if (!grid) return;
    if (grid._qrAllBound) return;
    grid._qrAllBound = true;
    grid.addEventListener('click', function (e) {
      var btn = e.target.closest('.qr-all-btn');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      if (btn.dataset.busy === '1') return;
      btn.dataset.busy = '1';
      btn.classList.add('qr-busy');
      var done = function () {
        btn.dataset.busy = '0';
        btn.classList.remove('qr-busy');
        btn.textContent = '全部';
      };
      generateAllQRCodes().then(done, function (err) {
        done();
        alert('批量生成失败：' + (err && err.message ? err.message : err));
      });
    }, true);
  }

  /* ============================================================
     ★ 批量打印二维码
     - 纸张下拉：默认 A4，含 A0~A6 / B0~B6 / Letter / Legal / Tabloid / Ledger + 自定义
     - 标签：预设 40×30 / 50×30 mm + 自定义
     - 打印：隐藏 iframe + @page(mm) + window.print()
     ============================================================ */
  var BP_KEY = 'ledger_batch_print_v1';

  /* 常用纸张尺寸表（mm，宽 x 高，纵向） */
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

  function defaultBatchPrintCfg() {
    return {
      title: '',
      columns: [],          // 选中的列 UUID（打印字段）
      paper: 'A4',
      paperW: 210, paperH: 297,
      labelPreset: '40x30',
      labelW: 40, labelH: 30
    };
  }
  function loadBatchPrintCfg() {
    var d = defaultBatchPrintCfg();
    try {
      var s = localStorage.getItem(BP_KEY);
      if (s) {
        var c = JSON.parse(s);
        for (var k in d) if (c && c[k] != null) d[k] = c[k];
      }
    } catch (e) {}
    return d;
  }
  function saveBatchPrintCfg(c) {
    try { localStorage.setItem(BP_KEY, JSON.stringify(c)); } catch (e) {}
  }
  function paperById(id) {
    for (var i = 0; i < PAPER_SIZES.length; i++) {
      if (PAPER_SIZES[i].id === id) return PAPER_SIZES[i];
    }
    return null;
  }
  /* 取当前生效的纸张宽高(mm) */
  function effectivePaper(cfg) {
    if (cfg.paper === 'custom') {
      return { w: Math.max(20, Number(cfg.paperW) || 210), h: Math.max(20, Number(cfg.paperH) || 297) };
    }
    var p = paperById(cfg.paper) || paperById('A4');
    return { w: p.w, h: p.h };
  }
  /* 取当前生效的标签宽高(mm) */
  function effectiveLabel(cfg) {
    if (cfg.labelPreset === 'custom') {
      return { w: Math.max(10, Number(cfg.labelW) || 40), h: Math.max(10, Number(cfg.labelH) || 30) };
    }
    var parts = String(cfg.labelPreset || '40x30').split('x');
    return { w: Number(parts[0]) || 40, h: Number(parts[1]) || 30 };
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
    });
  }
  /* 构造用于打印的二维码模板：显示所选字段 */
  function printQrTemplate(cfg) {
    var t = defaultQrTemplate();
    t.columns = cfg.columns || [];
    t.showHeader = true;
    t.textPosition = 'bottom';
    t.qrScale = 8; t.quietZone = 3; t.fontSize = 22; t.margin = 18; t.gap = 10;
    return t;
  }

  var bpBound = false;
  function bindBatchPrint() {
    var modal = document.getElementById('batchPrintModal');
    if (!modal || bpBound) return;
    bpBound = true;

    var paperSel = document.getElementById('bpPaper');
    PAPER_SIZES.forEach(function (p) {
      var o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.id + ' (' + p.w + '×' + p.h + 'mm)';
      paperSel.appendChild(o);
    });
    var oCustom = document.createElement('option');
    oCustom.value = 'custom'; oCustom.textContent = '自定义';
    paperSel.appendChild(oCustom);

    function onPaperChange() {
      var show = paperSel.value === 'custom';
      document.getElementById('bpPaperCustom').style.display = show ? '' : 'none';
      refreshPreview();
    }
    function onLabelChange() {
      var show = document.getElementById('bpLabelPreset').value === 'custom';
      document.getElementById('bpLabelCustom').style.display = show ? '' : 'none';
      refreshPreview();
    }
    paperSel.addEventListener('change', onPaperChange);
    document.getElementById('bpLabelPreset').addEventListener('change', onLabelChange);
    ['bpTitle', 'bpPaperW', 'bpPaperH', 'bpLabelW', 'bpLabelH'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener('input', refreshPreview);
    });
    document.getElementById('bpFields').addEventListener('change', refreshPreview);

    document.getElementById('bpClose').addEventListener('click', function () { modal.classList.add('hidden'); });
    document.getElementById('bpCancel').addEventListener('click', function () { modal.classList.add('hidden'); });
    modal.addEventListener('click', function (e) { if (e.target === modal) modal.classList.add('hidden'); });
    document.getElementById('bpPrint').addEventListener('click', doBatchPrint);
  }

  function collectBatchPrintCfg() {
    var cfg = defaultBatchPrintCfg();
    cfg.title = (document.getElementById('bpTitle').value || '').trim();
    var cols = [];
    Array.prototype.forEach.call(
      document.querySelectorAll('#bpFields input[type="checkbox"]'),
      function (cb) { if (cb.checked) cols.push(cb.value); }
    );
    cfg.columns = cols;
    cfg.paper = document.getElementById('bpPaper').value;
    cfg.paperW = Number(document.getElementById('bpPaperW').value) || 210;
    cfg.paperH = Number(document.getElementById('bpPaperH').value) || 297;
    cfg.labelPreset = document.getElementById('bpLabelPreset').value;
    cfg.labelW = Number(document.getElementById('bpLabelW').value) || 40;
    cfg.labelH = Number(document.getElementById('bpLabelH').value) || 30;
    return cfg;
  }

  /* 填写配置字段多选（复用列枚举，排除哨兵列与更新时间列） */
  function fillBatchPrintFields(cfg) {
    var host = document.getElementById('bpFields');
    host.innerHTML = '';
    var tcol = typeof findTimeColumn === 'function' ? findTimeColumn() : -1;
    if (!gridData[0] || gridData[0].length <= 1) {
      host.innerHTML = '<span class="bp-preview-empty">当前台账没有可打印的数据列</span>';
      return;
    }
    for (var c = 1; c < gridData[0].length; c++) {
      if (c === tcol) continue;
      var colId = getColumnIdAt(c);
      if (!colId || colId === UUID_SENTINEL) continue;
      var header = String(gridData[0][c] == null ? '' : gridData[0][c]).trim() || ('列' + c);
      var label = document.createElement('label');
      label.className = 'bp-field-check';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = colId;
      cb.checked = (cfg.columns || []).indexOf(colId) >= 0;
      var span = document.createElement('span');
      span.textContent = header;
      label.appendChild(cb); label.appendChild(span);
      host.appendChild(label);
    }
  }

  var bpPreviewUrls = [];
  async function refreshPreview() {
    var host = document.getElementById('bpPreview');
    if (!host) return;
    bpPreviewUrls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) {} });
    bpPreviewUrls = [];
    host.innerHTML = '';

    var cfg = collectBatchPrintCfg();
    saveBatchPrintCfg(cfg);

    var indexes = (typeof getSelectedRowIndexes === 'function') ? getSelectedRowIndexes() : [];
    var row = indexes.length ? indexes[0] : -1;
    if (row < 0) {
      host.innerHTML = '<span class="bp-preview-empty">请先勾选要打印的数据行，再查看预览</span>';
      return;
    }
    var tpl = printQrTemplate(cfg);
    var rowUuid = getRowUuid(row);
    if (!rowUuid || rowUuid === UUID_SENTINEL) {
      host.innerHTML = '<span class="bp-preview-empty">该行缺少唯一标识</span>';
      return;
    }
    var gid = 'L' + currentId + '_' + rowUuid;
    var blob;
    try { blob = await renderQrCard(gid, row, tpl); }
    catch (e) { host.innerHTML = '<span class="bp-preview-empty">预览生成失败：' + escapeHtml(e && e.message ? e.message : e) + '</span>'; return; }
    if (!blob) return;

    var url = URL.createObjectURL(blob);
    bpPreviewUrls.push(url);
    var lab = effectiveLabel(cfg);
    var card = document.createElement('div');
    card.className = 'bp-preview-card';
    // 预览按 1mm≈3.78px(96dpi) 等比缩放，最大 260px 宽，避免撑破弹窗
    var scale = Math.min(3.78, 260 / lab.w);
    card.style.width = Math.round(lab.w * scale) + 'px';
    card.style.minHeight = Math.round(lab.h * scale) + 'px';
    if (cfg.title) {
      var t = document.createElement('div');
      t.className = 'bp-preview-title';
      t.textContent = cfg.title;
      t.style.fontSize = Math.max(11, Math.min(20, lab.w * 0.5)) + 'px';
      card.appendChild(t);
    }
    var img = document.createElement('img');
    img.className = 'bp-preview-img';
    img.src = url;
    img.alt = '标签预览';
    card.appendChild(img);
    host.appendChild(card);
  }

  function blobToDataURL(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(new Error('图片读取失败')); };
      fr.readAsDataURL(blob);
    });
  }

  /* 生成打印 HTML：按纸张/标签尺寸(mm)排布，自动分页 */
  async function buildPrintHtml(cfg, indexes) {
    var paper = effectivePaper(cfg);
    var lab = effectiveLabel(cfg);
    var margin = 5; // 页边距 mm
    var gap = 2;   // 标签间距 mm
    var colsPerPage = Math.max(1, Math.floor((paper.w - margin * 2 + gap) / (lab.w + gap)));
    var rowsPerPage = Math.max(1, Math.floor((paper.h - margin * 2 + gap) / (lab.h + gap)));
    var perPage = colsPerPage * rowsPerPage;

    var tpl = printQrTemplate(cfg);
    var cards = []; // { dataUrl, title, caption }
    for (var i = 0; i < indexes.length; i++) {
      var row = indexes[i];
      var rowUuid = getRowUuid(row);
      if (!rowUuid || rowUuid === UUID_SENTINEL) continue;
      var gid = 'L' + currentId + '_' + rowUuid;
      var blob;
      try { blob = await renderQrCard(gid, row, tpl); }
      catch (e) { continue; }
      if (!blob) continue;
      var caption = '';
      try {
        var lines = collectQrLines(row, tpl);
        caption = lines.join(' / ');
      } catch (e) {}
      cards.push({ dataUrl: await blobToDataURL(blob), caption: caption });
    }
    if (!cards.length) return null;

    var pages = [];
    for (var p = 0; p < cards.length; p += perPage) {
      var chunk = cards.slice(p, p + perPage);
      var cells = chunk.map(function (c) {
        var titleHtml = cfg.title
          ? '<div class="lbl-title">' + escapeHtml(cfg.title) + '</div>'
          : '';
        return '<div class="lbl">' + titleHtml +
               '<img class="lbl-img" src="' + c.dataUrl + '">' +
               '</div>';
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

  async function doBatchPrint() {
    var cfg = collectBatchPrintCfg();
    var indexes = (typeof getSelectedRowIndexes === 'function') ? getSelectedRowIndexes() : [];
    if (!indexes.length) { alert('请先勾选要打印的行'); return; }
    if (typeof window.QRCodeGen === 'undefined') { alert('二维码组件未加载，请刷新页面'); return; }

    var btn = document.getElementById('bpPrint');
    var oldText = btn.textContent;
    btn.disabled = true; btn.textContent = '生成中…';
    try {
      var html = await buildPrintHtml(cfg, indexes);
      if (!html) { alert('没有可打印的二维码（所选行可能缺少唯一标识）'); return; }
      saveBatchPrintCfg(cfg);

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
        catch (e) { alert('唤起打印失败：' + (e && e.message ? e.message : e)); }
        cleanup();
      };
      if (doc.readyState === 'complete') printNow();
      else iframe.contentWindow.addEventListener('load', printNow, { once: true });
    } catch (e) {
      alert('批量打印失败：' + (e && e.message ? e.message : e));
    } finally {
      btn.disabled = false; btn.textContent = oldText;
    }
  }

  /* 打开批量打印配置弹窗 */
  function openBatchPrint() {
    if (!currentLedger) { alert('请先打开一本台账'); return; }
    if (typeof window.QRCodeGen === 'undefined') { alert('二维码组件未加载，请刷新页面'); return; }
    var indexes = (typeof getSelectedRowIndexes === 'function') ? getSelectedRowIndexes() : [];
    if (!indexes.length) { alert('请先勾选要打印的行'); return; }

    var modal = document.getElementById('batchPrintModal');
    if (!modal) return;
    bindBatchPrint();
    var cfg = loadBatchPrintCfg();

    fillBatchPrintFields(cfg);
    document.getElementById('bpTitle').value = cfg.title || '';
    var validPaper = !!paperById(cfg.paper) || cfg.paper === 'custom';
    document.getElementById('bpPaper').value = validPaper ? cfg.paper : 'A4';
    document.getElementById('bpPaperW').value = cfg.paperW || 210;
    document.getElementById('bpPaperH').value = cfg.paperH || 297;
    document.getElementById('bpLabelPreset').value = ['40x30', '50x30', 'custom'].indexOf(cfg.labelPreset) >= 0 ? cfg.labelPreset : '40x30';
    document.getElementById('bpLabelW').value = cfg.labelW || 40;
    document.getElementById('bpLabelH').value = cfg.labelH || 30;

    document.getElementById('bpPaperCustom').style.display = cfg.paper === 'custom' ? '' : 'none';
    document.getElementById('bpLabelCustom').style.display = cfg.labelPreset === 'custom' ? '' : 'none';
    modal.classList.remove('hidden');
    refreshPreview();
  }

  function bindAll() {
    bindGridQrClick();
    bindGridQrAllClick();
    bindGridQrSettingsClick();
    bindQrPreviewClose();
    bindQrTemplateModal();
    bindBatchPrint();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindAll);
  } else {
    bindAll();
  }

  window.RowQRCode = {
    generate: generateRowQRCode,
    generateAll: generateAllQRCodes
  };
  window.BatchPrint = {
    open: openBatchPrint
  };
})();