/* 背景设置：URL / 本地图片，存 localStorage，三页共享 */
(function () {
  'use strict';

  var KEY = 'ledger_bg_image';

  function applyBg(url) {
    if (url) {
      document.body.style.setProperty('--bg-image', 'url("' + url + '")');
      document.body.classList.add('has-bg');
    } else {
      document.body.style.removeProperty('--bg-image');
      document.body.classList.remove('has-bg');
    }
  }

  function getBg() {
    try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; }
  }

  function setBg(url) {
    try {
      if (url) localStorage.setItem(KEY, url);
      else localStorage.removeItem(KEY);
    } catch (e) {
      alert('保存失败：图片可能太大，超出浏览器本地存储限制\n建议改用图片 URL');
    }
    applyBg(url);
  }

  function openDialog() {
    var old = document.getElementById('bgModal');
    if (old) old.remove();

    var overlay = document.createElement('div');
    overlay.id = 'bgModal';
    overlay.className = 'modal-overlay';
    overlay.innerHTML = [
      '<div class="modal">',
      '  <div class="modal-header">',
      '    <h3>🎨 更换背景</h3>',
      '    <button class="modal-close" id="bgClose">×</button>',
      '  </div>',
      '  <div class="modal-body">',
      '    <label>图片 URL</label>',
      '    <input type="url" id="bgUrl" placeholder="https://example.com/image.jpg" style="margin-bottom:16px;">',
      '    <label>或上传本地图片</label>',
      '    <input type="file" id="bgFile" accept="image/*" style="width:100%;padding:8px;border:1px dashed var(--border);border-radius:var(--radius-sm);font-size:13px;">',
      '    <p style="font-size:12px;color:var(--text-light);margin-top:8px;line-height:1.6;">',
      '      本地上传的图片会存入浏览器 localStorage（建议 &lt; 1MB）；',
      '      大图请使用 URL。',
      '    </p>',
      '    <div id="bgPreview" style="margin-top:16px;height:120px;border-radius:var(--radius-sm);background:#f1f5f9;background-size:cover;background-position:center;display:flex;align-items:center;justify-content:center;color:var(--text-light);font-size:13px;">预览区域</div>',
      '  </div>',
      '  <div class="modal-footer">',
      '    <button class="outline" id="bgReset">恢复默认</button>',
      '    <button id="bgApply">应用</button>',
      '  </div>',
      '</div>'
    ].join('');
    document.body.appendChild(overlay);

    var urlInput = overlay.querySelector('#bgUrl');
    var fileInput = overlay.querySelector('#bgFile');
    var preview = overlay.querySelector('#bgPreview');
    var pendingUrl = null;

    var cur = getBg();
    if (cur && cur.indexOf('data:') !== 0) urlInput.value = cur;
    updatePreview(cur);

    function updatePreview(url) {
      if (url) {
        preview.style.backgroundImage = 'url("' + url + '")';
        preview.textContent = '';
      } else {
        preview.style.backgroundImage = '';
        preview.textContent = '预览区域';
      }
    }

    urlInput.addEventListener('input', function () {
      pendingUrl = null;
      updatePreview(urlInput.value.trim());
    });

    fileInput.addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (!f) return;
      if (f.size > 3 * 1024 * 1024) {
        if (!confirm('图片超过 3MB，可能无法保存。\n建议用图片 URL。继续？')) {
          fileInput.value = '';
          return;
        }
      }
      var reader = new FileReader();
      reader.onload = function (ev) {
        pendingUrl = ev.target.result;
        urlInput.value = '';
        updatePreview(pendingUrl);
      };
      reader.readAsDataURL(f);
    });

    function close() { overlay.remove(); }

    overlay.querySelector('#bgClose').addEventListener('click', close);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) close();
    });
    overlay.querySelector('#bgApply').addEventListener('click', function () {
      setBg(pendingUrl || urlInput.value.trim());
      close();
    });
    overlay.querySelector('#bgReset').addEventListener('click', function () {
      setBg('');
      close();
    });
  }

  function boot() {
    applyBg(getBg());
    window.LedgerBg = { get: getBg, set: setBg, apply: applyBg, openDialog: openDialog };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();