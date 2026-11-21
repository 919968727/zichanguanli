/* ============================================================
 * editor-members.js —— 成员与权限管理面板
 * ------------------------------------------------------------
 * 依赖：editor-core.js 里的 myRole / myPermissions / $ / api
 * 接口：
 *   GET    /api/ledgers/<lid>/members
 *   POST   /api/ledgers/<lid>/members
 *   PUT    /api/ledgers/<lid>/members/<target>
 *   DELETE /api/ledgers/<lid>/members/<target>
 *   POST   /api/ledgers/<lid>/transfer-owner
 *   POST   /api/ledgers/<lid>/revoke-grants
 *   GET    /api/ledgers/<lid>/requests
 *   POST   /api/ledgers/<lid>/requests
 *   POST   /api/ledgers/<lid>/requests/<rid>/review
 *   DELETE /api/ledgers/<lid>/requests/<rid>
 * ============================================================ */
(function () {
  'use strict';

  var modal = null;
  var state = {
    lid: null,
    members: [],
    permissionKeys: [],
    permissionLabels: {},
    roleLabels: {},
    presetPacks: {},
    myRole: null,
    myPermissions: {},
    isOwner: false,
    isRoot: false,
    tab: 'list',
    editingUser: null,       // 正在编辑的成员用户名
    addMemberDraft: null,    // 添加成员草稿
  };

  /* ---------- 工具 ---------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (k === 'class') e.className = attrs[k];
        else if (k === 'html') e.innerHTML = attrs[k];
        else if (k === 'text') e.textContent = attrs[k];
        else if (k.indexOf('on') === 0) {
          e.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
        } else {
          e.setAttribute(k, attrs[k]);
        }
      }
    }
    (children || []).forEach(function (c) {
      if (typeof c === 'string') e.appendChild(document.createTextNode(c));
      else if (c) e.appendChild(c);
    });
    return e;
  }
  function toast(msg, type) {
    if (typeof showActionToast === 'function') showActionToast(msg, type || 'success');
    else alert(msg);
  }

  /* ---------- 面板打开 ---------- */
  function openMembersModal() {
    if (!currentId) { alert('请先打开一本台账'); return; }
    if (!modal) buildModal();
    state.lid = currentId;
    state.tab = 'list';
    modal.classList.remove('hidden');
    $('membersLedgerName').textContent = currentLedger ? currentLedger.name : '';
    refreshMembers();
    if (myPermissions['member.approve'] || IS_ROOT) refreshRequests();
  }
  window.openMembersModal = openMembersModal;

  function closeMembersModal() {
    if (modal) modal.classList.add('hidden');
    state.editingUser = null;
    state.addMemberDraft = null;
  }

  /* ---------- 构建骨架 ---------- */
  function buildModal() {
    modal = el('div', {
      id: 'membersModal',
      class: 'modal-overlay hidden',
    });

    // 标题：图标 + 文案 + 台账名（台账名由 openMembersModal 填充，保持唯一 id）
    var h3 = el('h3', { class: 'modal-title' });
    h3.innerHTML = '<svg class="icon" viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg> 成员与权限 ';
    h3.appendChild(el('span', { id: 'membersLedgerName', style: 'font-size:13px;color:var(--text-muted);font-weight:400;' }));
    var header = el('div', { class: 'modal-header' }, [
      h3,
      el('button', { class: 'modal-close', id: 'membersClose', type: 'button', text: '×' }),
    ]);

    var canManagePanel = !!(myPermissions['member.manage'] || IS_ROOT);
    var canApprovePanel = !!(myPermissions['member.approve'] || IS_ROOT);

    var tabList = [
      el('button', { 'data-tab': 'list', class: 'members-tab active',
        text: canManagePanel ? '成员列表' : '我的权限' }),
    ];
    if (canApprovePanel) {
      tabList.push(el('button', { 'data-tab': 'requests', class: 'members-tab' }, [
        el('span', { text: '待审批 ' }),
        el('span', { id: 'requestsBadge', class: 'members-tab-badge hidden', text: '0' }),
      ]));
    }
    tabList.push(el('button', { 'data-tab': 'my-requests', class: 'members-tab', text: '我的申请' }));
    var tabs = el('div', { class: 'members-tabs' }, tabList);

    var panes = el('div', { class: 'modal-body members-body' }, [
      el('div', { id: 'membersPaneList', class: 'members-pane' }),
      el('div', { id: 'membersPaneRequests', class: 'members-pane hidden' }),
      el('div', { id: 'membersPaneMyRequests', class: 'members-pane hidden' }),
    ]);

    var dlg = el('div', { class: 'modal', style: 'max-width:900px;max-height:88vh;' }, [header, tabs, panes]);
    modal.appendChild(dlg);
    document.body.appendChild(modal);

    modal.addEventListener('click', function (e) {
      if (e.target === modal) closeMembersModal();
    });
    $('membersClose').addEventListener('click', closeMembersModal);
    Array.prototype.forEach.call(tabs.querySelectorAll('.members-tab'), function (b) {
      b.addEventListener('click', function () {
        state.tab = b.dataset.tab;
        Array.prototype.forEach.call(tabs.querySelectorAll('.members-tab'), function (x) {
          x.classList.toggle('active', x === b);
        });
        $('membersPaneList').classList.toggle('hidden', state.tab !== 'list');
        $('membersPaneRequests').classList.toggle('hidden', state.tab !== 'requests');
        $('membersPaneMyRequests').classList.toggle('hidden', state.tab !== 'my-requests');
        if (state.tab === 'requests') refreshRequests();
        if (state.tab === 'my-requests') refreshMyRequests();
      });
    });
  }

  /* ---------- 拉成员列表 ---------- */
  async function refreshMembers() {
    var pane = $('membersPaneList');
    pane.innerHTML = '<div class="members-loading">加载中…</div>';
    try {
      var data = await api('/api/ledgers/' + state.lid + '/members');
      state.members = data.members || [];
      state.permissionKeys = data.permission_keys || [];
      state.permissionLabels = data.permission_labels || {};
      state.roleLabels = data.role_labels || {};
      state.presetPacks = data.preset_packs || {};
      state.myRole = data.my_role;
      state.myPermissions = data.my_permissions || {};
      state.isOwner = !!data.is_owner;
      state.isRoot = !!data.is_root;
      renderMembersPane();
    } catch (e) {
      pane.innerHTML = '<div class="members-error">加载失败：' + esc(e.message || e) + '</div>';
    }
  }

  /* ---------- 渲染成员列表 ---------- */
  function renderMembersPane() {
    var pane = $('membersPaneList');
    pane.innerHTML = '';

    var canManage = !!(state.myPermissions['member.manage'] || state.isRoot);

    if (canManage) {
      // 顶部工具栏
      var toolbar = el('div', { class: 'members-toolbar' }, [
        el('span', { class: 'members-hint',
          text: '共 ' + state.members.length + ' 位成员' }),
        el('span', { style: 'flex:1' }),
        el('button', {
          class: 'small', id: 'btnAddMember', text: '+ 添加成员',
          onclick: function () { state.addMemberDraft = {}; renderAddMemberForm(); },
        }),
      ]);
      pane.appendChild(toolbar);

      // 添加成员表单（默认隐藏）
      pane.appendChild(el('div', { id: 'addMemberHost' }));

      // 成员卡片列表
      var list = el('div', { class: 'members-list', id: 'membersList' });
      state.members.forEach(function (m) {
        list.appendChild(buildMemberCard(m));
      });
      pane.appendChild(list);
    }

    // 我的权限摘要
    var myPermsSummary = el('div', { class: 'members-mypanel' });
    myPermsSummary.appendChild(el('div', { class: 'members-mypanel-title', text: '我的权限' }));
    var permGrid = el('div', { class: 'members-perms-grid' });
    state.permissionKeys.forEach(function (k) {
      var has = !!state.myPermissions[k];
      permGrid.appendChild(el('div', {
        class: 'members-perm-chip' + (has ? ' on' : ' off'),
      }, [
        el('span', { class: 'members-perm-icon', text: has ? '✓' : '✕' }),
        el('span', { text: state.permissionLabels[k] || k }),
      ]));
    });
    myPermsSummary.appendChild(permGrid);

    // 申请新权限按钮
    if (state.myRole && state.myRole !== 'owner' && !state.isRoot) {
      var canRequestAny = state.permissionKeys.some(function (k) {
        return !state.myPermissions[k];
      });
      if (canRequestAny) {
        myPermsSummary.appendChild(el('button', {
          class: 'outline small', style: 'margin-top:10px;',
          text: '📝 申请新权限',
          onclick: function () { renderRequestForm(); },
        }));
      }
    }
    pane.appendChild(myPermsSummary);

    // 申请权限表单（默认隐藏）
    pane.appendChild(el('div', { id: 'requestFormHost' }));
  }

  function buildMemberCard(m) {
    var card = el('div', { class: 'members-card' });

    // 头像
    var av = el('div', { class: 'members-avatar' });
    av.textContent = (m.username || '?').slice(0, 1).toUpperCase();
    if (m.role === 'owner') av.classList.add('is-owner');
    else if (m.role === 'manager') av.classList.add('is-manager');

    // 用户名 + 角色
    var info = el('div', { class: 'members-info' });
    var nameLine = el('div', { class: 'members-name' }, [
      el('span', { text: m.username }),
      el('span', {
        class: 'members-role-tag ' + 'role-' + m.role,
        text: (state.roleLabels[m.role] || m.role),
      }),
    ]);
    info.appendChild(nameLine);

    // 权限图标
    var perms = el('div', { class: 'members-perms-inline' });
    state.permissionKeys.forEach(function (k) {
      if (!m[k]) return;
      perms.appendChild(el('span', {
        class: 'members-perm-chip mini on',
        title: state.permissionLabels[k] || k,
        text: state.permissionLabels[k] || k,
      }));
    });
    if (!perms.children.length) {
      perms.appendChild(el('span', {
        class: 'members-perm-chip mini off',
        text: '（无权限）',
      }));
    }
    info.appendChild(perms);

    // 操作按钮
    var actions = el('div', { class: 'members-actions' });

    if (m.role !== 'owner') {
      var canEdit = state.isOwner ||
        (state.myRole === 'manager' && m.role === 'member');
      var canRemove = canEdit;
      if (canEdit) {
        actions.appendChild(el('button', {
          class: 'small outline', text: '编辑',
          onclick: function () { state.editingUser = m.username; renderMembersPane(); },
        }));
      }
      if (canRemove) {
        actions.appendChild(el('button', {
          class: 'small danger', text: '移除',
          onclick: function () { doRemoveMember(m.username); },
        }));
      }
    }

    // 转让 owner 按钮（仅 owner / root 看非 owner 成员）
    if (m.role !== 'owner' && state.isOwner) {
      actions.appendChild(el('button', {
        class: 'small outline', text: '转让 owner',
        title: '把台账所有权转让给该成员',
        onclick: function () { doTransferOwner(m.username); },
      }));
    }

    card.appendChild(av);
    card.appendChild(info);
    card.appendChild(actions);

    // 编辑区（动态插入）
    if (state.editingUser === m.username) {
      var editHost = el('div', { class: 'members-edit-host', id: 'editHost_' + m.username });
      card.appendChild(editHost);
      setTimeout(function () { renderEditMemberForm(m); }, 0);
    }

    return card;
  }

  /* ---------- 添加成员表单 ---------- */
  function renderAddMemberForm() {
    var host = $('addMemberHost');
    host.innerHTML = '';
    var isOwnerUser = state.isOwner || state.isRoot;
    var canAddManager = isOwnerUser;

    var form = el('div', { class: 'members-form' });
    form.appendChild(el('div', { class: 'members-form-title', text: '添加成员' }));

    var row1 = el('div', { class: 'members-form-row' });
    row1.appendChild(el('label', { text: '用户名' }));
    var nameInp = el('input', {
      type: 'text', id: 'addNameInp', placeholder: '输入用户名',
      autocomplete: 'off',
    });
    row1.appendChild(nameInp);
    form.appendChild(row1);

    var row2 = el('div', { class: 'members-form-row' });
    row2.appendChild(el('label', { text: '角色 / 预设权限包' }));
    var presetSel = el('select', { id: 'addPresetSel' });
    Object.keys(state.presetPacks).forEach(function (key) {
      var p = state.presetPacks[key];
      if (key === 'owner') return;  // 添加成员不能选 owner
      if (p.role === 'manager' && !canAddManager) return;
      presetSel.appendChild(el('option', { value: key, text: p.label }));
    });
    row2.appendChild(presetSel);
    form.appendChild(row2);

    // 权限勾选区
    var permsGrid = el('div', { class: 'members-perms-grid', id: 'addPermsGrid' });
    form.appendChild(permsGrid);

    var btnRow = el('div', { class: 'members-form-actions' }, [
      el('button', {
        class: 'outline small', type: 'button', text: '取消',
        onclick: function () { state.addMemberDraft = null; host.innerHTML = ''; },
      }),
      el('button', {
        class: 'small', type: 'button', text: '添加',
        onclick: doAddMember,
      }),
    ]);
    form.appendChild(btnRow);

    host.appendChild(form);

    function refreshPermsFromPreset() {
      var presetKey = presetSel.value;
      var preset = state.presetPacks[presetKey] || { perms: {} };
      var isCustom = presetKey === 'custom';
      permsGrid.innerHTML = '';
      state.permissionKeys.forEach(function (k) {
        var has = !!preset.perms[k];
        var myHas = state.isRoot || !!state.myPermissions[k];
        var disabled = !isCustom || !myHas;
        var cb = el('input', {
          type: 'checkbox',
          'data-key': k,
          ...(has ? { checked: 'checked' } : {}),
          ...(disabled ? { disabled: 'disabled' } : {}),
        });
        var label = el('label', { class: 'members-perm-check' + (myHas ? '' : ' denied') }, [
          cb,
          el('span', { text: state.permissionLabels[k] || k }),
          myHas ? null : el('span', { class: 'members-perm-denied', text: '（你没有此权限）' }),
        ]);
        permsGrid.appendChild(label);
      });
    }

    presetSel.addEventListener('change', refreshPermsFromPreset);
    refreshPermsFromPreset();
  }

  async function doAddMember() {
    var name = ($('addNameInp').value || '').trim();
    var preset = $('addPresetSel').value;
    if (!name) { alert('请输入用户名'); return; }
    var p = state.presetPacks[preset] || { role: 'member', perms: {} };
    var perms = {};
    var isCustom = (preset === 'custom');
    if (isCustom) {
      Array.prototype.forEach.call($('addPermsGrid').querySelectorAll('input'), function (cb) {
        if (cb.checked) perms[cb.dataset.key] = 1;
      });
    } else {
      perms = p.perms || {};
    }
    try {
      await api('/api/ledgers/' + state.lid + '/members', {
        method: 'POST',
        body: JSON.stringify({
          username: name,
          role: isCustom ? 'member' : p.role,
          permissions: perms,
          preset: isCustom ? '' : preset,
        }),
      });
      toast('已添加：' + name);
      state.addMemberDraft = null;
      $('addMemberHost').innerHTML = '';
      refreshMembers();
    } catch (e) {
      alert('添加失败：' + e.message);
    }
  }

  /* ---------- 编辑成员表单 ---------- */
  function renderEditMemberForm(m) {
    var host = $('editHost_' + m.username);
    if (!host) return;
    host.innerHTML = '';

    var form = el('div', { class: 'members-form', style: 'margin-top:10px;' });
    form.appendChild(el('div', { class: 'members-form-title', text: '编辑：' + m.username }));

    // 角色选择
    var rowRole = el('div', { class: 'members-form-row' });
    rowRole.appendChild(el('label', { text: '角色' }));
    var roleSel = el('select', { id: 'editRoleSel_' + m.username });
    roleSel.appendChild(el('option', { value: 'member', text: '成员（member）' }));
    if (state.isOwner) {
      roleSel.appendChild(el('option', { value: 'manager', text: '管理者（manager）' }));
    }
    roleSel.value = m.role;
    rowRole.appendChild(roleSel);
    form.appendChild(rowRole);

    // 权限勾选
    var permsGrid = el('div', { class: 'members-perms-grid' });
    state.permissionKeys.forEach(function (k) {
      var has = !!m[k];
      var myHas = state.isRoot || !!state.myPermissions[k] ||
                  (state.isOwner ? true : false);
      // manager 不能授出自己没有的；owner 可以授出全部
      var grantable = state.isOwner || state.isRoot ||
                      (state.myRole === 'manager' && state.myPermissions[k] && has ? true : state.myPermissions[k]);
      // 简化：只要「自己有的」都能授；owner 全有
      var canToggle = state.isOwner || state.isRoot || !!state.myPermissions[k];
      var cb = el('input', {
        type: 'checkbox', 'data-key': k,
        ...(has ? { checked: 'checked' } : {}),
        ...(canToggle ? {} : { disabled: 'disabled' }),
      });
      var label = el('label', { class: 'members-perm-check' + (canToggle ? '' : ' denied') }, [
        cb,
        el('span', { text: state.permissionLabels[k] || k }),
        canToggle ? null : el('span', { class: 'members-perm-denied', text: '（你没有此权限）' }),
      ]);
      permsGrid.appendChild(label);
    });
    form.appendChild(permsGrid);

    var btnRow = el('div', { class: 'members-form-actions' }, [
      el('button', {
        class: 'outline small', type: 'button', text: '取消',
        onclick: function () { state.editingUser = null; renderMembersPane(); },
      }),
      el('button', {
        class: 'small', type: 'button', text: '保存',
        onclick: async function () {
          var newRole = roleSel.value;
          var perms = {};
          Array.prototype.forEach.call(permsGrid.querySelectorAll('input'), function (cb) {
            if (cb.checked) perms[cb.dataset.key] = 1;
          });
          try {
            await api('/api/ledgers/' + state.lid + '/members/' + encodeURIComponent(m.username), {
              method: 'PUT',
              body: JSON.stringify({ role: newRole, permissions: perms }),
            });
            toast('已更新：' + m.username);
            state.editingUser = null;
            refreshMembers();
          } catch (e) {
            alert('更新失败：' + e.message);
          }
        },
      }),
    ]);
    form.appendChild(btnRow);

    host.appendChild(form);
  }

  /* ---------- 移除成员 ---------- */
  async function doRemoveMember(username) {
    if (!confirm('确定移除成员「' + username + '」？\n该成员将立即失去本台账的所有权限。')) return;
    try {
      await api('/api/ledgers/' + state.lid + '/members/' + encodeURIComponent(username), {
        method: 'DELETE',
      });
      toast('已移除：' + username);
      refreshMembers();
    } catch (e) {
      alert('移除失败：' + e.message);
    }
  }

  /* ---------- 转让 owner ---------- */
  async function doTransferOwner(username) {
    if (!confirm('确定把台账所有权转让给「' + username + '」？\n\n' +
      '· 你将成为管理者，保留全部权限\n' +
      '· 对方成为所有者，拥有全部权限\n' +
      '· 此操作不可逆（除非对方再转回）')) return;
    try {
      await api('/api/ledgers/' + state.lid + '/transfer-owner', {
        method: 'POST',
        body: JSON.stringify({ new_owner: username, keep_grants: true }),
      });
      toast('已转让给：' + username);
      closeMembersModal();
      if (typeof openLedger === 'function') openLedger(currentId, { force: true });
    } catch (e) {
      alert('转让失败：' + e.message);
    }
  }

  /* ---------- 权限申请（我发起的） ---------- */
  function renderRequestForm() {
    var host = $('requestFormHost');
    host.innerHTML = '';
    var form = el('div', { class: 'members-form' });
    form.appendChild(el('div', { class: 'members-form-title', text: '申请新权限' }));

    var row1 = el('div', { class: 'members-form-row' });
    row1.appendChild(el('label', { text: '权限' }));
    var permSel = el('select', { id: 'reqPermSel' });
    state.permissionKeys.forEach(function (k) {
      if (state.myPermissions[k]) return;
      permSel.appendChild(el('option', { value: k, text: state.permissionLabels[k] || k }));
    });
    if (!permSel.children.length) {
      permSel.appendChild(el('option', { value: '', text: '（你已有全部权限）' }));
    }
    row1.appendChild(permSel);
    form.appendChild(row1);

    var row2 = el('div', { class: 'members-form-row' });
    row2.appendChild(el('label', { text: '申请理由（可选）' }));
    var reasonInp = el('input', { type: 'text', id: 'reqReasonInp', placeholder: '如：需要导出月度报表给领导' });
    row2.appendChild(reasonInp);
    form.appendChild(row2);

    form.appendChild(el('div', { class: 'members-form-actions' }, [
      el('button', {
        class: 'outline small', text: '取消',
        onclick: function () { host.innerHTML = ''; },
      }),
      el('button', {
        class: 'small', text: '提交申请',
        onclick: async function () {
          var perm = permSel.value;
          if (!perm) return;
          try {
            await api('/api/ledgers/' + state.lid + '/requests', {
              method: 'POST',
              body: JSON.stringify({ permission: perm, reason: reasonInp.value || '' }),
            });
            toast('申请已提交');
            host.innerHTML = '';
            refreshMyRequests();
          } catch (e) {
            alert('提交失败：' + e.message);
          }
        },
      }),
    ]));
    host.appendChild(form);
  }

  async function refreshMyRequests() {
    var pane = $('membersPaneMyRequests');
    pane.innerHTML = '<div class="members-loading">加载中…</div>';
    try {
      var data = await api('/api/ledgers/' + state.lid + '/requests');
      var rows = data.requests || [];
      pane.innerHTML = '';
      if (!rows.length) {
        pane.appendChild(el('div', { class: 'members-empty', text: '暂无申请记录' }));
        return;
      }
      var list = el('div', { class: 'members-requests-list' });
      rows.forEach(function (r) {
        list.appendChild(buildRequestCard(r, false));
      });
      pane.appendChild(list);
    } catch (e) {
      pane.innerHTML = '<div class="members-error">加载失败：' + esc(e.message || e) + '</div>';
    }
  }

  /* ---------- 待审批请求 ---------- */
  async function refreshRequests() {
    var pane = $('membersPaneRequests');
    pane.innerHTML = '<div class="members-loading">加载中…</div>';
    try {
      var data = await api('/api/ledgers/' + state.lid + '/requests?status=pending');
      var rows = data.requests || [];
      var canApprove = !!data.can_approve;
      pane.innerHTML = '';
      if (!canApprove) {
        pane.appendChild(el('div', { class: 'members-empty', text: '你没有审批权限' }));
        return;
      }
      // 只去掉自己提交的申请（避免自己审批自己）；owner 自己的申请保留
      var myName = (window.CURRENT_USER || '').toString();
      var filtered = rows.filter(function (r) { return r.username !== myName; });

      var badge = $('requestsBadge');
      if (badge) {
        if (filtered.length > 0) {
          badge.textContent = filtered.length;
          badge.classList.remove('hidden');
        } else {
          badge.classList.add('hidden');
        }
      }

      if (!filtered.length) {
        pane.appendChild(el('div', { class: 'members-empty', text: '暂无待审批申请' }));
        return;
      }
      var list = el('div', { class: 'members-requests-list' });
      filtered.forEach(function (r) {
        list.appendChild(buildRequestCard(r, true));
      });
      pane.appendChild(list);
    } catch (e) {
      pane.innerHTML = '<div class="members-error">加载失败：' + esc(e.message || e) + '</div>';
    }
  }

  function buildRequestCard(r, canReview) {
    var card = el('div', { class: 'members-req-card' });
    var statusMap = {
      pending: '待审批', approved: '已批准', rejected: '已驳回', cancelled: '已取消',
    };
    var statusCls = {
      pending: 'status-pending', approved: 'status-approved',
      rejected: 'status-rejected', cancelled: 'status-cancelled',
    };
    var row1 = el('div', { class: 'members-req-row1' }, [
      el('span', { class: 'members-req-user', text: r.username }),
      el('span', { class: 'members-req-perm', text: '申请：' +
        (state.permissionLabels[r.permission] || r.permission) }),
      el('span', { class: 'members-req-status ' + (statusCls[r.status] || ''), text:
        statusMap[r.status] || r.status }),
    ]);
    card.appendChild(row1);

    if (r.reason) {
      card.appendChild(el('div', { class: 'members-req-reason', text: '理由：' + r.reason }));
    }
    card.appendChild(el('div', { class: 'members-req-time', text: r.requested_at || '' }));

    if (r.reviewed_by) {
      card.appendChild(el('div', { class: 'members-req-review', text:
        '审批人：' + r.reviewed_by + ' · ' + (r.reviewed_at || '') +
        (r.review_note ? ' · ' + r.review_note : '') }));
    }

    // 操作按钮
    if (canReview && r.status === 'pending') {
      var actions = el('div', { class: 'members-req-actions' }, [
        el('button', {
          class: 'small success', text: '批准',
          onclick: function () { doReview(r.id, 'approved'); },
        }),
        el('button', {
          class: 'small danger', text: '驳回',
          onclick: function () { doReview(r.id, 'rejected'); },
        }),
      ]);
      card.appendChild(actions);
    } else if (!canReview && r.status === 'pending' && r.username === (window.CURRENT_USER || '')) {
      var actions2 = el('div', { class: 'members-req-actions' }, [
        el('button', {
          class: 'small outline', text: '取消申请',
          onclick: async function () {
            try {
              await api('/api/ledgers/' + state.lid + '/requests/' + r.id, {
                method: 'DELETE',
              });
              toast('已取消');
              refreshMyRequests();
            } catch (e) { alert('取消失败：' + e.message); }
          },
        }),
      ]);
      card.appendChild(actions2);
    }

    return card;
  }

  async function doReview(rid, decision) {
    var note = '';
    if (decision === 'rejected') {
      note = prompt('驳回理由（可选）', '') || '';
    }
    try {
      await api('/api/ledgers/' + state.lid + '/requests/' + rid + '/review', {
        method: 'POST',
        body: JSON.stringify({ decision: decision, note: note }),
      });
      toast(decision === 'approved' ? '已批准' : '已驳回');
      refreshRequests();
    } catch (e) {
      alert('处理失败：' + e.message);
    }
  }

  /* ---------- 暴露 ---------- */
  window.openMembersModal = openMembersModal;
  window.closeMembersModal = closeMembersModal;
})();