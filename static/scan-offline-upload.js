/* ============================================================
 * scan-offline-upload.js —— 在线终端「离线数据回传」页
 * ------------------------------------------------------------
 * 流程：选择 JSON → 预览 → POST /api/offline/uploads → 显示结果
 * ============================================================ */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var dropZone = $('dropZone');
  var fileInput = $('fileInput');
  var fileMeta = $('fileMeta');
  var previewPanel = $('previewPanel');
  var previewBody = $('previewBody');
  var actionBar = $('actionBar');
  var btnUpload = $('btnUpload');
  var btnReset = $('btnReset');
  var btnAgain = $('btnAgain');
  var resultPanel = $('resultPanel');
  var resOk = $('resOk');
  var resFail = $('resFail');
  var resSkip = $('resSkip');
  var resTotal = $('resTotal');
  var resultList = $('resultList');

  var currentPayload = null;
  var uploading = false;

  /* ---------- 工具 ---------- */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function resetAll() {
    currentPayload = null;
    fileInput.value = '';
    fileMeta.classList.add('hidden');
    previewPanel.classList.add('hidden');
    actionBar.classList.add('hidden');
    resultPanel.classList.add('hidden');
    dropZone.classList.remove('hidden');
    btnUpload.disabled = false;
    btnUpload.textContent = '开始上传';
  }

  /* ---------- 拖拽 / 选择 ---------- */
  dropZone.addEventListener('click', function () { fileInput.click(); });
  dropZone.addEventListener('dragover', function (e) {
    e.preventDefault(); dropZone.classList.add('dragover');
  });
  dropZone.addEventListener('dragleave', function () {
    dropZone.classList.remove('dragover');
  });
  dropZone.addEventListener('drop', function (e) {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    var f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) readFile(f);
  });
  fileInput.addEventListener('change', function () {
    var f = fileInput.files && fileInput.files[0];
    if (f) readFile(f);
  });

  function readFile(file) {
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
      if (!s.app_id || !s.gid || !s.action_id) {
        alert('第 ' + (i + 1) + ' 条缺少 app_id / gid / action_id');
        return;
      }
    }
    currentPayload = data;
    renderPreview(data);
  }

  /* ---------- 预览 ---------- */
  function renderPreview(data) {
    $('metaBatch').textContent = data.batch_id;
    $('metaApp').textContent = (data.app_name || data.app_id || '（未知）');
    $('metaExported').textContent = data.exported_at || '—';
    $('metaCount').textContent = String(data.scans.length);
    fileMeta.classList.remove('hidden');

    previewBody.innerHTML = '';
    data.scans.forEach(function (s, i) {
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td>' + (i + 1) + '</td>' +
        '<td>' + esc(s.action_label || s.action_id) + '</td>' +
        '<td class="gid">' + esc(s.gid) + '</td>' +
        '<td>' + esc(s.scanned_at || '') + '</td>';
      previewBody.appendChild(tr);
    });
    previewPanel.classList.remove('hidden');
    actionBar.classList.remove('hidden');
    resultPanel.classList.add('hidden');
    dropZone.classList.add('hidden');
  }

  /* ---------- 上传 ---------- */
  btnUpload.addEventListener('click', doUpload);
  btnReset.addEventListener('click', resetAll);
  btnAgain.addEventListener('click', resetAll);

  async function doUpload() {
    if (uploading || !currentPayload) return;
    uploading = true;
    btnUpload.disabled = true;
    btnUpload.textContent = '上传中…（' + currentPayload.scans.length + ' 条）';

    try {
      var res = await fetch('/api/offline/uploads', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': window.CSRF,
        },
        body: JSON.stringify({
          batch_id: currentPayload.batch_id,
          scans: currentPayload.scans,
        }),
      });

      if (res.status === 401) {
        alert('登录已失效，请重新登录');
        window.location.href = '/scan-login?next=/offline-upload';
        return;
      }
      var data = {};
      try { data = await res.json(); } catch (e) {}
      if (!res.ok) {
        alert(data.msg || ('上传失败：HTTP ' + res.status));
        return;
      }
      renderResults(data);
    } catch (e) {
      alert('网络错误：' + e.message);
    } finally {
      uploading = false;
      btnUpload.disabled = false;
      btnUpload.textContent = '开始上传';
    }
  }

  function renderResults(data) {
    resOk.textContent = String(data.ok || 0);
    resFail.textContent = String(data.failed || 0);
    resSkip.textContent = String(data.skipped || 0);
    resTotal.textContent = String(data.total || 0);

    resultList.innerHTML = '';
    (data.results || []).forEach(function (r) {
      var cls = r.status === 'ok' ? 'ok'
              : r.status === 'skipped' ? 'skip' : 'fail';
      var label = r.status === 'ok' ? '成功'
                : r.status === 'skipped' ? '跳过' : '失败';
      var div = document.createElement('div');
      div.className = 'result-item';
      div.innerHTML =
        '<span class="idx">#' + (r.index + 1) + '</span>' +
        '<span class="badge ' + cls + '">' + label + '</span>' +
        '<span class="msg">' +
          esc(r.action_label || '') +
          (r.msg ? '：' + esc(r.msg) : '') +
        '</span>';
      resultList.appendChild(div);
    });

    resultPanel.classList.remove('hidden');
    previewPanel.classList.add('hidden');
    actionBar.classList.add('hidden');
    dropZone.classList.add('hidden');

    if ((data.failed || 0) > 0) {
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    }
  }

})();