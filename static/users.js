/* users.js —— 用户管理页（系统角色 / 树形组织 / 功能开关） */
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  async function api(url, options) {
    options = options || {};
    options.headers = Object.assign(
      { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF },
      options.headers || {}
    );
    var res = await fetch(url, options);
    if (res.status === 401) { location.href = '/'; throw new Error('未登录'); }
    var data = {};
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) { throw new Error(data.msg || ('请求失败 ' + res.status)); }
    return data;
  }
  function roleTag(role) {
    var label = ({ super_admin: '超级管理员', admin: '管理员', user: '普通用户' })[role] || role;
    return '<span class="tag tag-role ' + esc(role) + '">' + esc(label) + '</span>';
  }

  var context = null;   // /api/admin/context 结果
  var orgs = [];
  var users = [];
  var featureUser = null;

  /* ---------- 用户列表 ---------- */
  async function loadUsers() {
    try {
      var d = await api('/api/admin/users');
      users = d.users || [];
      $('umPendingCount').textContent = d.pending_count || 0;
      var tbody = $('umUserRows');
      if (!users.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="um-empty">暂无用户</td></tr>';
        return;
      }
      var orgName = {};
      orgs.forEach(function (o) { orgName[o.id] = o.name; });
      tbody.innerHTML = users.map(function (u) {
        var isSelf = u.username === CURRENT_USER;
        var canManage = IS_SUPER || (context && context.role === 'admin');
        var acts = [];
        if (u.status === 'pending' && canManage) {
          acts.push('<button class="um-btn" data-act="approve" data-u="' + esc(u.username) + '">通过注册</button>');
        }
        if (canManage) {
          acts.push('<button class="um-btn" data-act="ledger-perms" data-u="' + esc(u.username) + '">台账权限</button>');
        }
        if (canManage && !isSelf) {
          acts.push('<button class="um-btn danger" data-act="delete" data-u="' + esc(u.username) + '">删除</button>');
        }
        return '<tr>' +
          '<td>' + esc(u.username) + (isSelf ? '（我）' : '') + '</td>' +
          '<td>' + roleTag(u.role) + '</td>' +
          '<td>' + esc(u.org_name || '—') + '</td>' +
          '<td><span class="tag tag-status-' + esc(u.status) + '">' +
            (u.status === 'approved' ? '已通过' : '待审批') + '</span></td>' +
          '<td><div class="um-actions">' + (acts.join('') || '—') + '</div></td>' +
        '</tr>';
      }).join('');
    } catch (e) { alert('加载用户失败：' + e.message); }
  }

  /* ---------- 组织架构 ---------- */
  function orgTreeHtml(parentId) {
    var children = orgs.filter(function (o) { return o.parent_id === parentId; });
    if (!children.length) return '';
    return '<div class="org-children">' + children.map(function (o) {
      var cnt = users.filter(function (u) { return u.org_id === o.id; }).length;
      var acts = '';
      acts = '<button class="um-btn" data-act="org-add-child" data-id="' + o.id + '">+子组织</button>' +
             '<button class="um-btn danger" data-act="org-del" data-id="' + o.id + '">删除</button>';
      return '<li class="org-node"><div class="org-row">' +
        '<span class="org-name">' + esc(o.name) + '</span>' +
        '<span class="org-id">' + cnt + ' 人</span>' + acts +
        '</div>' + orgTreeHtml(o.id) + '</li>';
    }).join('') + '</div>';
  }
  function loadOrgTree() {
    var roots = orgs.filter(function (o) { return o.parent_id == null; });
    $('umOrgTree').innerHTML = roots.length
      ? roots.map(function (o) {
          var cnt = users.filter(function (u) { return u.org_id === o.id; }).length;
          var acts = '<button class="um-btn" data-act="org-add-child" data-id="' + o.id + '">+子组织</button>' +
                     '<button class="um-btn danger" data-act="org-del" data-id="' + o.id + '">删除</button>';
          return '<li class="org-node"><div class="org-row">' +
            '<span class="org-name">' + esc(o.name) + '</span>' +
            '<span class="org-id">' + cnt + ' 人</span>' + acts +
            '</div>' + orgTreeHtml(o.id) + '</li>';
        }).join('')
      : '<li class="um-empty">暂无组织，点击「新建组织」创建顶层组织</li>';
    var sel = $('umOrgParent');
    sel.innerHTML = '<option value="">（顶层组织）</option>' + orgs.map(function (o) {
      return '<option value="' + o.id + '">' + esc(o.name) + '</option>';
    }).join('');
  }

  /* ---------- 用户台账权限 ---------- */
  var lpUser = null;
  var lpData = null;
  async function openLedgerPermsModal(username) {
    lpUser = username;
    $('umLpTitle').textContent = '「' + username + '」的台账权限';
    $('umLpModal').classList.remove('hidden');
    $('umLpBody').innerHTML = '<div class="um-empty">加载中…</div>';
    try {
      var d = await api('/api/admin/users/' + encodeURIComponent(username) + '/ledger-permissions');
      lpData = d;
      renderLedgerPerms();
    } catch (e) {
      $('umLpBody').innerHTML = '<div class="um-empty">加载失败：' + esc(e.message) + '</div>';
    }
  }
  function renderLedgerPerms() {
    if (!lpData) return;
    var keys = lpData.permission_keys || [];
    var labels = lpData.permission_labels || {};
    var items = lpData.items || [];
    $('umLpBody').innerHTML = items.map(function (it) {
      var roleSel = '<select class="um-select lp-role" data-lid="' + it.ledger_id + '">' +
        '<option value="">未参与</option>' +
        '<option value="manager"' + (it.role === 'manager' ? ' selected' : '') + '>管理者 manager</option>' +
        '<option value="member"' + (it.role === 'member' ? ' selected' : '') + '>成员 member</option>' +
        (it.role === 'owner' ? '<option value="owner" selected>所有者 owner（不可改）</option>' : '') +
        '</select>';
      var checks = keys.map(function (k) {
        var on = it.permissions && it.permissions[k];
        return '<label style="display:inline-flex;align-items:center;gap:3px;margin:3px 8px 3px 0;font-size:12px;">' +
          '<input type="checkbox" class="lp-perm" data-lid="' + it.ledger_id + '" data-k="' + esc(k) + '"' +
          (on ? ' checked' : '') + (it.role === 'owner' ? ' disabled' : '') + '>' +
          esc(labels[k] || k) + '</label>';
      }).join('');
      return '<div class="lp-card" style="border:1px solid var(--um-border);border-radius:8px;padding:12px;margin-bottom:10px;">' +
        '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">' +
        '<b style="flex:1;">' + esc(it.ledger_name) + '</b>' + roleSel +
        (it.role && it.role !== 'owner'
          ? '<button class="um-btn danger" data-act="lp-remove" data-lid="' + it.ledger_id + '">移除</button>'
          : '') +
        '</div>' +
        (it.role === 'owner'
          ? '<div class="um-hint" style="margin:0;">所有者拥有全部权限，如需变更请在台账内转让。</div>'
          : '<div>' + checks + '</div>') +
        '<button class="um-btn primary" data-act="lp-save" data-lid="' + it.ledger_id + '"' +
        (it.role && it.role !== 'owner' ? '' : ' disabled') + ' style="margin-top:8px;">保存该台账权限</button>' +
        '</div>';
    }).join('') || '<div class="um-empty">暂无台账</div>';
  }

  /* ---------- 新建用户 ---------- */
  function fillOrgSelect(sel, withEmpty) {
    var prev = sel.value;
    sel.innerHTML = (withEmpty ? '<option value="">（无组织）</option>' : '') +
      orgs.map(function (o) {
        return '<option value="' + o.id + '">' + esc(o.name) + '</option>';
      }).join('');
    if (prev && sel.querySelector('option[value="' + prev + '"]')) sel.value = prev;
  }
  function openUserModal() {
    $('umNewUsername').value = '';
    $('umNewPassword').value = '';
    $('umNewRole').value = 'user';
    // 管理员只能建普通用户
    var adminOpt = $('umNewRoleAdmin');
    if (adminOpt) adminOpt.style.display = IS_SUPER ? '' : 'none';
    fillOrgSelect($('umNewOrg'), true);
    $('umUserModal').classList.remove('hidden');
  }

  /* ---------- 功能开关 ---------- */
  function fillFeatureUsers() {
    var sel = $('umFeatureUser');
    var prev = sel.value;
    sel.innerHTML = users.map(function (u) {
      return '<option value="' + esc(u.username) + '">' + esc(u.username) + '</option>';
    }).join('');
    if (prev && sel.querySelector('option[value="' + prev + '"]')) sel.value = prev;
    featureUser = sel.value || null;
  }
  async function loadFeatures() {
    if (!featureUser) { $('umFeatureGrid').innerHTML = '<div class="um-empty">暂无用户</div>'; return; }
    try {
      var d = await api('/api/admin/users/' + encodeURIComponent(featureUser) + '/features');
      var f = d.features || {};
      $('umFeatureGrid').innerHTML = (context.features || []).map(function (item) {
        var on = !!f[item.key];
        return '<div class="feature-card"><label>' + esc(item.label) + '</label>' +
          '<button class="um-switch ' + (on ? 'on' : '') + '" data-feature="' + esc(item.key) + '" aria-label="' + esc(item.label) + '"></button></div>';
      }).join('');
    } catch (e) { alert('加载功能权限失败：' + e.message); }
  }

  /* ---------- 事件 ---------- */
  function bind() {
    document.querySelectorAll('.um-tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        document.querySelectorAll('.um-tab').forEach(function (t) { t.classList.remove('active'); });
        document.querySelectorAll('.um-panel').forEach(function (p) { p.classList.remove('active'); });
        tab.classList.add('active');
        $('umPanel' + tab.dataset.tab.charAt(0).toUpperCase() + tab.dataset.tab.slice(1)).classList.add('active');
      });
    });
    $('umRefreshUsers').addEventListener('click', loadUsers);
    $('umAddUser').addEventListener('click', openUserModal);
    $('umUserCancel').addEventListener('click', function () { $('umUserModal').classList.add('hidden'); });
    $('umLpClose').addEventListener('click', function () { $('umLpModal').classList.add('hidden'); });
    $('umLpBody').addEventListener('click', async function (e) {
      var btn = e.target.closest('button[data-act]');
      if (!btn || !lpUser) return;
      var lid = btn.dataset.lid;
      try {
        if (btn.dataset.act === 'lp-save') {
          var roleSel = this.querySelector('.lp-role[data-lid="' + lid + '"]');
          var role = roleSel ? roleSel.value : '';
          if (!role || role === 'owner') { alert('请选择 manager 或 member'); return; }
          var perms = {};
          this.querySelectorAll('.lp-perm[data-lid="' + lid + '"]').forEach(function (cb) {
            perms[cb.dataset.k] = cb.checked ? 1 : 0;
          });
          await api('/api/admin/users/' + encodeURIComponent(lpUser) + '/ledger-permissions/' + lid,
            { method: 'PUT', body: JSON.stringify({ role: role, permissions: perms }) });
          openLedgerPermsModal(lpUser);
        } else if (btn.dataset.act === 'lp-remove') {
          if (!confirm('移除该用户在此台账的成员权限？')) return;
          await api('/api/admin/users/' + encodeURIComponent(lpUser) + '/ledger-permissions/' + lid,
            { method: 'DELETE' });
          openLedgerPermsModal(lpUser);
        }
      } catch (err) { alert('操作失败：' + err.message); }
    });
    $('umUserSave').addEventListener('click', async function () {
      var username = $('umNewUsername').value.trim();
      var password = $('umNewPassword').value;
      var role = $('umNewRole').value;
      var org = $('umNewOrg').value || null;
      if (!username || username.length < 2) { alert('用户名至少 2 字符'); return; }
      if (password.length < 4) { alert('密码至少 4 位'); return; }
      try {
        await api('/api/admin/users', {
          method: 'POST',
          body: JSON.stringify({ username: username, password: password, role: role, org_id: org })
        });
        $('umUserModal').classList.add('hidden');
        await loadUsers();
        loadOrgTree();
        fillFeatureUsers();
        loadFeatures();
      } catch (e) { alert('创建失败：' + e.message); }
    });
    $('umRefreshOrgs').addEventListener('click', function () { loadUsers().then(loadOrgTree); });
    $('umRefreshFeatures').addEventListener('click', loadFeatures);
    $('umFeatureUser').addEventListener('change', function () { featureUser = this.value; loadFeatures(); });

    $('umUserRows').addEventListener('click', async function (e) {
      var btn = e.target.closest('button[data-act]');
      if (!btn) return;
      var u = btn.dataset.u, act = btn.dataset.act;
      try {
        if (act === 'approve') {
          if (!confirm('通过用户「' + u + '」的注册申请？')) return;
          await api('/api/admin/users/' + encodeURIComponent(u) + '/approve', { method: 'POST' });
          await loadUsers();
        } else if (act === 'delete') {
          if (!confirm('删除用户「' + u + '」？此操作不可恢复。')) return;
          await api('/api/admin/users/' + encodeURIComponent(u), { method: 'DELETE' });
          await loadUsers().then(loadOrgTree);
        } else if (act === 'ledger-perms') {
          openLedgerPermsModal(u);
        }
      } catch (err) { alert('操作失败：' + err.message); }
    });

    $('umOrgTree').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-act]');
      if (!btn) return;
      if (btn.dataset.act === 'org-add-child') openOrgModal(Number(btn.dataset.id));
      else if (btn.dataset.act === 'org-del') {
        if (!confirm('删除该组织？需先移走其下用户与子组织。')) return;
        api('/api/admin/orgs/' + btn.dataset.id, { method: 'DELETE' })
          .then(function () { return loadUsers(); }).then(loadOrgTree)
          .catch(function (err) { alert('删除失败：' + err.message); });
      }
    });

    $('umAddOrg').addEventListener('click', function () { openOrgModal(null); });
    $('umOrgCancel').addEventListener('click', function () { $('umOrgModal').classList.add('hidden'); });
    $('umOrgSave').addEventListener('click', async function () {
      var name = $('umOrgName').value.trim();
      if (!name) { alert('请填写组织名称'); return; }
      var pid = $('umOrgParent').value || null;
      try {
        await api('/api/admin/orgs', { method: 'POST', body: JSON.stringify({ name: name, parent_id: pid }) });
        $('umOrgModal').classList.add('hidden');
        $('umOrgName').value = '';
        await loadUsers();
        loadOrgTree();
      } catch (e) { alert('创建失败：' + e.message); }
    });

    $('umFeatureGrid').addEventListener('click', async function (e) {
      var btn = e.target.closest('.um-switch');
      if (!btn || !featureUser) return;
      var feature = btn.dataset.feature;
      var enabled = !btn.classList.contains('on');
      try {
        await api('/api/admin/users/' + encodeURIComponent(featureUser) + '/features/' + encodeURIComponent(feature),
          { method: 'PUT', body: JSON.stringify({ enabled: enabled }) });
        btn.classList.toggle('on', enabled);
      } catch (err) { alert('设置失败：' + err.message); }
    });
  }

  function openOrgModal(parentId) {
    $('umOrgName').value = '';
    $('umOrgParent').value = parentId == null ? '' : String(parentId);
    $('umOrgModal').classList.remove('hidden');
  }

  async function init() {
    try {
      context = await api('/api/admin/context');
      orgs = context.orgs || [];
      await loadUsers();
      loadOrgTree();
      fillFeatureUsers();
      loadFeatures();
      bind();
    } catch (e) {
      document.querySelector('.um-wrap').innerHTML = '<div class="um-empty">加载失败：' + esc(e.message) + '</div>';
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
