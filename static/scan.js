/* ============================================================
 * scan.js —— 扫码终端核心逻辑
 * ============================================================ */
(function () {
  'use strict';

  var APP       = window.SCAN_APP || {};
  var API_BASE  = '/api/scan-apps/' + APP.app_id + '/scan';
  var CSRF      = window.CSRF || '';
  var $         = function (id) { return document.getElementById(id); };

  var kbInput      = $('kbInput');
  var cardArea     = $('cardArea');
  var cardFields   = $('cardFields');
  var cardActions  = $('cardActions');
  var cardStatus   = $('cardStatus');
  var historyList  = $('historyList');
  var btnCamera    = $('btnCamera');
  var btnLogout    = $('btnLogout');
  var cameraModal  = $('cameraModal');
  var cameraReader = $('cameraReader');
  var cameraClose  = $('cameraClose');
  var toastEl      = $('toast');

  var history       = [];
  var currentGid    = null;
  var cameraStream  = null;
  var scanRAF       = null;
  var cameraTimeoutId = null;

  /* ============================================================
   * 焦点保活
   * ============================================================ */
  function refocus() {
    if (!kbInput) return;
    setTimeout(function () {
      try { kbInput.focus({ preventScroll: true }); } catch (e) {}
    }, 80);
  }

  document.addEventListener('click', function (e) {
    if (e.target.closest('button') || e.target.closest('a')) return;
    if (e.target.closest('#__scanModeOverlay')) return;
    refocus();
  });

  /* ============================================================
   * 扫码枪输入
   * ============================================================ */
  if (kbInput) {
    kbInput.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.keyCode !== 13) return;
      e.preventDefault();
      var gid = kbInput.value.trim();
      kbInput.value = '';
      if (gid) doScan(gid);
      refocus();
    });
  }

  /* ============================================================
   * 「扫描二维码」按钮
   * ============================================================ */
  var _lastClickTs = 0;
  if (btnCamera) {
    btnCamera.addEventListener('click', function (e) {
      e.preventDefault();
      var now = Date.now();
      if (now - _lastClickTs < 500) return;
      _lastClickTs = now;
      showScanModeDialog();
    });
  }

  function showScanModeDialog() {
    var old = document.getElementById('__scanModeOverlay');
    if (old) old.remove();

    var overlay = document.createElement('div');
    overlay.id = '__scanModeOverlay';
    overlay.style.cssText =
      'position:fixed;top:0;left:0;right:0;bottom:0;' +
      'background:rgba(0,0,0,.72);z-index:99999;' +
      'display:flex;align-items:center;justify-content:center;padding:20px;';

    var box = document.createElement('div');
    box.style.cssText =
      'background:#1e293b;color:#f1f5f9;border-radius:16px;padding:22px;' +
      'max-width:340px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.55);';

    var isSecure = !!window.isSecureContext;
    var html =
      '<h3 style="margin:0 0 6px;font-size:17px;text-align:center;font-weight:600;">选择扫码方式</h3>' +
      '<p style="margin:0 0 16px;font-size:12px;color:#94a3b8;text-align:center;line-height:1.5;">' +
        '手机推荐「拍照识别」，无需摄像头权限，HTTP 下也能用' +
      '</p>' +
      '<button type="button" id="__scanModePhoto" style="width:100%;padding:14px;margin-bottom:10px;' +
        'background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;border:none;border-radius:10px;' +
        'font-size:15px;font-weight:600;cursor:pointer;">📷 拍照识别</button>';
    if (isSecure) {
      html +=
        '<button type="button" id="__scanModeRealtime" style="width:100%;padding:14px;margin-bottom:10px;' +
          'background:#334155;color:#f1f5f9;border:1px solid #475569;border-radius:10px;' +
          'font-size:15px;font-weight:600;cursor:pointer;">🎥 实时摄像头</button>';
    }
    html +=
      '<button type="button" id="__scanModeCancel" style="width:100%;padding:10px;' +
        'background:transparent;color:#94a3b8;border:none;font-size:13px;cursor:pointer;">取消</button>';
    box.innerHTML = html;

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    function bind(id, handler) {
      var el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        handler();
      });
    }
    bind('__scanModePhoto',    function () { overlay.remove(); usePhotoCamera(); });
    bind('__scanModeRealtime', function () { overlay.remove(); startRealtimeCamera(); });
    bind('__scanModeCancel',   function () { overlay.remove(); refocus(); });
  }

  /* ============================================================
   * 方式一：拍照识别
   * ============================================================ */
  function usePhotoCamera() {
    if (typeof window.jsQR !== 'function') {
      alert('二维码识别组件（jsQR）未加载，请刷新页面后重试');
      return;
    }
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.setAttribute('capture', 'environment');
    input.style.cssText = 'position:fixed;left:-9999px;top:-9999px;';
    document.body.appendChild(input);

    input.addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      try { document.body.removeChild(input); } catch (err) {}
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function (ev) { decodeQrFromImage(ev.target.result); };
      reader.onerror = function () { alert('读取图片失败，请重试'); };
      reader.readAsDataURL(file);
    });
    input.click();
  }

  function decodeQrFromImage(dataUrl) {
    var img = new Image();
    img.onload = function () {
      try {
        var maxSide = Math.max(img.width, img.height);
        var scale = Math.min(1, 1600 / maxSide);
        var w = Math.max(1, Math.round(img.width * scale));
        var h = Math.max(1, Math.round(img.height * scale));

        var canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, w, h);
        var imgData = ctx.getImageData(0, 0, w, h);

        var code = window.jsQR(imgData.data, imgData.width, imgData.height, {
          inversionAttempts: 'attemptBoth'
        });
        if (code && code.data) {
          doScan(code.data);
        } else {
          if (confirm('未识别到二维码。\n\n可能照片模糊或被遮挡。是否重新拍照？')) {
            usePhotoCamera();
          }
        }
      } catch (err) {
        alert('识别失败：' + (err && err.message ? err.message : err));
      }
    };
    img.onerror = function () { alert('图片加载失败，请重试'); };
    img.src = dataUrl;
  }

  /* ============================================================
   * 方式二：实时摄像头
   * ============================================================ */
  function startRealtimeCamera() {
    if (typeof window.jsQR === 'undefined') {
      alert('jsQR 未就绪，请改用「拍照识别」');
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      if (confirm('当前浏览器不支持实时摄像头（HTTP 下不可用）。\n\n是否改用「拍照识别」？')) {
        usePhotoCamera();
      }
      return;
    }
    if (!cameraModal || !cameraReader) return;

    cameraModal.classList.remove('hidden');
    cameraReader.innerHTML =
      '<div style="color:#fff;text-align:center;padding:60px 20px;font-size:15px;line-height:1.8;">' +
      '正在启动摄像头…<br><span style="font-size:13px;opacity:.7;">5 秒内无响应会自动提示改用拍照识别</span></div>';

    var settled = false;
    cameraTimeoutId = setTimeout(function () {
      if (settled) return;
      settled = true;
      if (confirm('实时摄像头无响应。\n\n是否改用「拍照识别」？')) usePhotoCamera();
      else closeCameraModal();
    }, 5000);

    navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } }
    }).then(function (stream) {
      if (settled) {
        try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
        return;
      }
      settled = true;
      if (cameraTimeoutId) { clearTimeout(cameraTimeoutId); cameraTimeoutId = null; }
      startVideoStream(stream);
    }).catch(function (e) {
      if (settled) return;
      settled = true;
      if (cameraTimeoutId) { clearTimeout(cameraTimeoutId); cameraTimeoutId = null; }
      var msg = '无法打开摄像头';
      if (e && (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError')) {
        msg = '摄像头权限被拒绝';
      } else if (e && e.name === 'NotFoundError') {
        msg = '本设备没有可用摄像头';
      } else if (e && e.name === 'NotReadableError') {
        msg = '摄像头被其它应用占用';
      } else if (e && e.name === 'SecurityError') {
        msg = '浏览器安全策略阻止了摄像头（通常因为 HTTP 或证书问题）';
      } else if (e && e.message) {
        msg = '无法打开摄像头：' + e.message;
      }
      if (confirm(msg + '\n\n是否改用「拍照识别」？')) usePhotoCamera();
      else closeCameraModal();
    });
  }

  function startVideoStream(stream) {
    if (!cameraModal || !cameraReader) return;
    cameraReader.innerHTML = '';
    cameraModal.classList.remove('hidden');

    var video = document.createElement('video');
    video.setAttribute('autoplay', 'true');
    video.setAttribute('muted', 'true');
    video.setAttribute('playsinline', 'true');
    video.setAttribute('webkit-playsinline', 'true');
    video.style.cssText = 'width:100%;max-width:500px;display:block;';
    cameraReader.appendChild(video);

    var canvas = document.createElement('canvas');
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    cameraStream = stream;
    video.srcObject = stream;
    var p = video.play();
    if (p && p.catch) p.catch(function () {});

    setTimeout(function () { tick(); }, 300);

    function tick() {
      if (!cameraStream) return;
      if (video.readyState === 4 || video.readyState === video.HAVE_ENOUGH_DATA) {
        var w = video.videoWidth, h = video.videoHeight;
        if (w && h) {
          canvas.width = w;
          canvas.height = h;
          ctx.drawImage(video, 0, 0, w, h);
          try {
            var img = ctx.getImageData(0, 0, w, h);
            var code = window.jsQR(img.data, img.width, img.height, {
              inversionAttempts: 'dontInvert'
            });
            if (code && code.data) {
              stopCamera();
              doScan(code.data);
              return;
            }
          } catch (e) {}
        }
      }
      scanRAF = requestAnimationFrame(tick);
    }
  }

  function closeCameraModal() {
    if (cameraModal) cameraModal.classList.add('hidden');
    if (cameraReader) cameraReader.innerHTML = '';
  }

  function stopCamera() {
    if (cameraTimeoutId) { clearTimeout(cameraTimeoutId); cameraTimeoutId = null; }
    closeCameraModal();
    if (scanRAF) { cancelAnimationFrame(scanRAF); scanRAF = null; }
    if (cameraStream) {
      cameraStream.getTracks().forEach(function (t) { t.stop(); });
      cameraStream = null;
    }
    refocus();
  }

  if (cameraClose) cameraClose.addEventListener('click', stopCamera);

  /* ============================================================
   * 扫码 API
   * ============================================================ */
  function doScan(gid) {
    currentGid = gid;
    showCardLoading();
    fetch(API_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF },
      body: JSON.stringify({ gid: gid })
    }).then(function (res) { return res.json(); })
      .then(function (data) {
        renderCard(data);
        if (data.status !== 'active') addHistory(gid, data.msg || data.status, false);
      })
      .catch(function (e) { renderError('网络错误：' + e.message); });
  }

  /* ============================================================
   * 根据 value_type 生成时间类写入值
   *   fixed  -> 返回 null（后端用 action.value）
   *   now    -> 2024-11-12 14:23:05
   *   today  -> 2024-11-12
   *   time   -> 14:23:05
   * ============================================================ */
  function formatActionValue(a) {
    var vt = a && a.value_type;
    if (!vt || vt === 'fixed') return null;
    var d = new Date();
    function pad(n) { return n < 10 ? '0' + n : '' + n; }
    if (vt === 'now') {
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
             ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    }
    if (vt === 'today') {
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    }
    if (vt === 'time') {
      return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    }
    return null;
  }

  /* ============================================================
   * 执行快捷操作
   * ============================================================ */
  function doAction(a) {
    if (!currentGid) return;
    if (a.confirm) {
      var tip = a.danger
        ? '确定执行「' + a.label + '」？此操作较严重。'
        : '确定执行「' + a.label + '」？';
      if (!confirm(tip)) return;
    }

    var payload = { gid: currentGid, action_id: a.id };

    // 时间类动作：把当前时间作为 action_value 一起提交，后端优先使用它
    var override = formatActionValue(a);
    if (override !== null) payload.action_value = override;

    fetch(API_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF },
      body: JSON.stringify(payload)
    }).then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.status === 'ok') {
          toast('✓ ' + data.action_label, 'success');
          playSuccessAudio();
          renderCard(data);
          addHistory(currentGid, data.action_label, true);
          if (APP.auto_clear_after_ms) {
            setTimeout(clearCard, APP.auto_clear_after_ms);
          }
        } else if (data.status === 'busy') {
          /* ★ 该台账正在被其他人保存：卡片保持原样，用户可再点一次 */
          toast(data.msg || '保存繁忙，请稍后重试', 'error');
        } else {
          toast(data.msg || '操作失败', 'error');
          addHistory(currentGid, data.msg || '失败', false);
        }
      })
      .catch(function (e) { toast('网络错误：' + e.message, 'error'); });
  }

  /* ============================================================
   * 渲染结果卡片
   * ============================================================ */
  function renderCard(data) {
    if (!cardArea) return;
    cardArea.classList.remove('hidden');

    var statusMap = {
      active:         { text: '✓ 已识别',           cls: 'ok' },
      ok:             { text: '✓ 操作成功',         cls: 'ok' },
      archived:       { text: '⚠ 该行已封存',       cls: 'warn' },
      forbidden:      { text: '⚠ 无权访问',         cls: 'warn' },
      ledger_deleted: { text: '✕ 台账已删除',       cls: 'error' },
      not_found:      { text: '✕ 未找到数据',       cls: 'error' },
      wrong_ledger:   { text: '⚠ 二维码不属于本应用', cls: 'warn' },
      invalid:        { text: '✕ 无效二维码',       cls: 'error' }
    };
    var st = statusMap[data.status] || statusMap.not_found;
    cardStatus.textContent =
      (data.msg && data.status !== 'active' && data.status !== 'ok')
        ? (st.text + '：' + data.msg)
        : st.text;
    cardStatus.className = 'scan-card-status ' + st.cls;

    cardFields.innerHTML = '';
    (data.display_data || []).forEach(function (item) {
      var dt = document.createElement('dt');
      dt.textContent = item.label;
      var dd = document.createElement('dd');
      dd.textContent = item.value || '—';
      if (item.highlight) dd.className = 'highlight';
      cardFields.appendChild(dt);
      cardFields.appendChild(dd);
    });

    cardActions.innerHTML = '';
    if (data.actions && data.actions.length) {
      data.actions.forEach(function (a) {
        var btn = document.createElement('button');
        btn.className = 'scan-action-btn' + (a.danger ? ' danger' : '');
        btn.textContent = a.label;
        btn.addEventListener('click', function () { doAction(a); });
        cardActions.appendChild(btn);
      });
    } else if (data.status === 'active') {
      cardActions.innerHTML = '<div class="scan-no-actions">该应用不提供操作</div>';
    }

    try { cardArea.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
    catch (e) { cardArea.scrollIntoView(false); }
  }

  function showCardLoading() {
    if (!cardArea) return;
    cardArea.classList.remove('hidden');
    cardStatus.textContent = '扫描中…';
    cardStatus.className = 'scan-card-status';
    cardFields.innerHTML = '';
    cardActions.innerHTML = '';
  }

  function renderError(msg) {
    if (!cardArea) return;
    cardArea.classList.remove('hidden');
    cardStatus.textContent = '✕ ' + msg;
    cardStatus.className = 'scan-card-status error';
    cardFields.innerHTML = '';
    cardActions.innerHTML = '';
  }

  function clearCard() {
    if (cardArea) cardArea.classList.add('hidden');
    currentGid = null;
    refocus();
  }

  /* ============================================================
   * 本次记录
   * ============================================================ */
  function addHistory(gid, result, ok) {
    var time = new Date().toLocaleTimeString('zh-CN', {
      hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    var m = gid.match(/_([0-9a-f]{6})/);
    var title = m ? m[1] : gid.slice(0, 12);
    history.unshift({ time: time, title: title, result: result, ok: ok });
    if (history.length > 30) history.pop();
    renderHistory();
  }

  function renderHistory() {
    if (!historyList) return;
    historyList.innerHTML = '';
    if (!history.length) {
      historyList.innerHTML = '<li class="scan-empty">暂无记录</li>';
      return;
    }
    history.forEach(function (h) {
      var li = document.createElement('li');
      li.className = 'scan-history-item' + (h.ok ? '' : ' error');
      var t  = document.createElement('span'); t.className  = 'time';   t.textContent  = h.time;
      var ti = document.createElement('span'); ti.className = 'title';  ti.textContent = h.title;
      var r  = document.createElement('span'); r.className  = 'result'; r.textContent  = h.result;
      li.appendChild(t); li.appendChild(ti); li.appendChild(r);
      historyList.appendChild(li);
    });
  }

  /* ============================================================
   * Toast / 音效
   * ============================================================ */
  function toast(msg, type) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.className = 'scan-toast show ' + (type || '');
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(function () { toastEl.className = 'scan-toast'; }, 2200);
  }

  function playSuccessAudio() {
    if (!APP.success_audio) return;
    try {
      var ctx = new (window.AudioContext || window.webkitAudioContext)();
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
      osc.start();
      osc.stop(ctx.currentTime + 0.15);
    } catch (e) {}
  }

  /* ============================================================
   * 退出登录
   * ============================================================ */
  if (btnLogout) {
    btnLogout.addEventListener('click', function () {
      if (!confirm('确定退出登录？')) return;
      fetch('/logout', {
        method: 'POST',
        headers: { 'X-CSRF-Token': CSRF }
      }).then(function () { location.href = '/scan-login'; })
        .catch(function () { location.href = '/scan-login'; });
    });
  }

  /* ============================================================
   * 初始化
   * ============================================================ */
  renderHistory();
  refocus();
  console.log('[scan] 核心扫码脚本已加载');
})();