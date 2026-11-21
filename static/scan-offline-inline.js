/* ============================================================
 * scan-offline-inline.js —— 扫码页内「上传离线数据」弹层
 * ------------------------------------------------------------
 * 流程：选 JSON → 预览（含 app_id 匹配提示）→ 上传 → 结果
 * 接口：POST /api/offline/uploads（幂等，已成功过自动跳过）
 * ============================================================ */
(function () {
  'use strict';

  var modal = document.getElementById('offlineModal');
  if (!modal) return;   // 不在扫码页，直接返回

  var currentApp = (window.SCAN_APP && window.SCAN_APP.app_id) || '';
  var currentAppName = (window.SCAN_APP && window.SCAN_APP.name) || currentApp;

  var $ = function (id) { return document.getElementById(id); };

  var btnOpen = $('btnOfflineUpload');
  var btnClose = $('offlineClose');
  var btnReset = $('offlineBtnReset');
  var btnUpload = $('offlineBtnUpload');
  var fileInput = $('offlineFileInput');
  var dropZone = modal.querySelector('.scan-offline-drop');

  var step1 = $('offlineStep1');
  var step2 = $('offlineStep2');
  var step3 = $('offlineStep3');

  var payload = null;        // 当前文件解析后的对象
  var uploading = false;

  /* ---------- 工具 ---------- */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ---------- 打开/关闭 ---------- */
  function openModal() {
    modal.classList.remove('hidden');
    reset();
  }
  function closeModal() {
    if (uploading) return;
    modal.classList.add('hidden');
  }

  function reset() {
    payload = null;
    uploading = false;
    fileInput.value = '';
    step1.classList.remove('hidden');
    step2.classList.add('hidden');
    step3.classList.add('hidden');
    btnUpload.disabled = true;
    btnUpload.textContent = '开始上传';
  }

  /* ---------- 文件处理 ---------- */
  function handleFile(file) {
    if (!/\.json$/i.test(file.name) && file.type !== 'application/json') {
      alert('请选择 JSON 文件');
      return;
    }
    var reader = new FileReader();
    reader.onload = function (e) {
      try {
        var data = JSON.parse(e.target.result);
        validatePayload(data);
      } catch (err) {
        alert('文件解析失败：' + err.message);
      }
    };
    reader.onerror = function () { alert('文件读取失败'); };
    reader.readAsText(file, 'utf-8');
  }

  function validatePayload(data) {
    if (!data || typeof data !== 'object') {
      alert('JSON 内容无效'); return;
    }
    if (!data.batch_id) {
      alert('缺少 batch_id，可能不是本系统导出的离线文件'); return;
    }
    if (!Array.isArray(data.scans) || !data.scans.length) {
      alert('scans 为空'); return;
    }
    for (var i = 0; i < data.scans.length; i++) {
      var s = data.scans[i];
      if (!s || !s.app_id || !s.gid || !s.action_id) {
        alert('第 ' + (i + 1) + ' 条缺少 app_id / gid / action_id');
        return;
      }
    }
    payload = data;
    renderPreview();
  }

  /* ---------- 预览 ---------- */
  function renderPreview() {
    // 提取应用集合
    var appIdSet = {};
    payload.scans.forEach(function (s) { appIdSet[s.app_id] = true; });
    var appIds = Object.keys(appIdSet).sort();

    $('offlineBatchId').textContent = payload.batch_id;
    $('offlineAppIds').textContent = appIds.join(', ');
    $('offlineCount').textContent = payload.scans.length + ' 条';
    $('offlineExportedAt').textContent = payload.exported_at || '—';

    // 与当前应用的匹配提示
    var warnEl = $('offlineAppWarning');
    warnEl.classList.add('hidden');
    warnEl.className = 'scan-offline-warning hidden';

    if (currentApp) {
      if (appIds.indexOf(currentApp) === -1) {
        warnEl.textContent = '⚠ 这份数据不含当前应用（' + currentAppName + '）的记录。' +
                             '上传后服务端会把它们分别应用到各自的目标台账。';
        warnEl.className = 'scan-offline-warning';
      } else if (appIds.length === 1 && appIds[0] === currentApp) {
        warnEl.textContent = '✓ 数据与当前应用（' + currentAppName + '）匹配。';
        warnEl.className = 'scan-offline-warning scan-offline-warning-ok';
      } else {
        warnEl.textContent = 'ℹ 混合数据：含当前应用（' + currentAppName + '）以及 ' +
                             appIds.filter(function (a) { return a !== currentApp; }).join(', ') +
                             '，服务端会分别处理。';
        warnEl.className = 'scan-offline-warning';
      }
    }

    // 前 20 条预览
    var list = $('offlinePreviewList');
    list.innerHTML = '';
    var preview = payload.scans.slice(0, 20);
    preview.forEach(function (s, i) {
      var item = document.createElement('div');
      item.className = 'scan-offline-prev-item';
      item.innerHTML =
        '<span class="idx">#' + (i + 1) + '</span>' +
        '<span class="app">' + esc(s.app_id) + '</span>' +
        '<span class="action">' + esc(s.action_label || s.action_id) + '</span>' +
        '<span class="time">' + esc(s.scanned_at || '') + '</span>';
      list.appendChild(item);
    });
    if (payload.scans.length > 20) {
      var more = document.createElement('div');
      more.className = 'scan-offline-prev-item scan-offline-prev-more';
      more.textContent = '…… 还有 ' + (payload.scans.length - 20) + ' 条未显示';
      list.appendChild(more);
    }

    step1.classList.add('hidden');
    step2.classList.remove('hidden');
    step3.classList.add('hidden');
    btnUpload.disabled = false;
    btnUpload.textContent = '开始上传（' + payload.scans.length + ' 条）';
  }

  /* ---------- 上传 ---------- */
  async function doUpload() {
    if (uploading || !payload) return;
    uploading = true;
    btnUpload.disabled = true;
    btnUpload.textContent = '上传中…';

    try {
      var res = await fetch('/api/offline/uploads', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': window.CSRF || ''
        },
        body: JSON.stringify({
          batch_id: payload.batch_id,
          scans: payload.scans
        })
      });

      if (res.status === 401) {
        alert('登录已失效，请重新登录');
        window.location.href = '/scan-login?next=' +
          encodeURIComponent(location.pathname);
        return;
      }
      if (res.status === 403) {
        alert('CSRF 校验失败，请刷新页面');
        return;
      }

      var data = {};
      try { data = await res.json(); } catch (e) {}
      if (!res.ok) {
        alert(data.msg || ('上传失败：HTTP ' + res.status));
        return;
      }

      renderResult(data);
    } catch (e) {
      alert('网络错误：' + e.message);
    } finally {
      uploading = false;
    }
  }

  /* ---------- 结果 ---------- */
  function renderResult(data) {
    var okN = data.ok || 0;
    var failN = data.failed || 0;
    var skipN = data.skipped || 0;

    $('offlineResOk').textContent = okN;
    $('offlineResFail').textContent = failN;
    $('offlineResSkip').textContent = skipN;

    var list = $('offlineResultList');
    list.innerHTML = '';
    (data.results || []).forEach(function (r) {
      var cls = r.status === 'ok' ? 'ok'
              : r.status === 'skipped' ? 'skip' : 'fail';
      var label = r.status === 'ok' ? '成功'
                : r.status === 'skipped' ? '跳过' : '失败';
      var item = document.createElement('div');
      item.className = 'scan-offline-res-item';
      item.innerHTML =
        '<span class="idx">#' + (r.index + 1) + '</span>' +
        '<span class="badge ' + cls + '">' + label + '</span>' +
        '<span class="msg">' +
          esc(r.action_label || '') +
          (r.msg ? '：' + esc(r.msg) : '') +
        '</span>';
      list.appendChild(item);
    });

    step1.classList.add('hidden');
    step2.classList.add('hidden');
    step3.classList.remove('hidden');

    // 有失败 → 允许只重试失败项（后端幂等，已成功的会跳过）
    var failedScans = [];
    (data.results || []).forEach(function (r) {
      if (r.status === 'failed' || r.status === 'busy') {
        var s = payload.scans[r.index];
        if (s) failedScans.push(s);
      }
    });

    if (failedScans.length > 0) {
      btnUpload.disabled = false;
      btnUpload.textContent = '重试失败项（' + failedScans.length + '）';
      btnUpload.onclick = function () {
        // 用失败的项重组 payload
        payload = Object.assign({}, payload, { scans: failedScans });
        btnUpload.onclick = doUpload;
        doUpload();
      };
    } else {
      btnUpload.disabled = true;
      btnUpload.textContent = '全部完成';
      btnUpload.onclick = doUpload;
    }
  }

  /* ---------- 事件绑定 ---------- */
  btnOpen.addEventListener('click', openModal);
  btnClose.addEventListener('click', closeModal);
  btnReset.addEventListener('click', reset);

  // 初始：btnUpload 的 onclick 是 doUpload；重试时临时替换
  btnUpload.onclick = doUpload;

  modal.addEventListener('click', function (e) {
    if (e.target === modal) closeModal();
  });

  fileInput.addEventListener('change', function (e) {
    var f = e.target.files && e.target.files[0];
    if (f) handleFile(f);
  });

  // 拖拽
  if (dropZone) {
    dropZone.addEventListener('dragover', function (e) {
      e.preventDefault();
      dropZone.classList.add('dragover');
    });
    dropZone.addEventListener('dragleave', function () {
      dropZone.classList.remove('dragover');
    });
    dropZone.addEventListener('drop', function (e) {
      e.preventDefault();
      dropZone.classList.remove('dragover');
      var f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handleFile(f);
    });
  }

})();