// Admins page: manage admin accounts.

export const scriptAdmins = `  function renderAdmins() {
    var view = document.getElementById('view');
    var data = state.admins;
    var roleSelect = isSuperAdmin()
      ? '<select id="admin-role" class="grow"><option value="admin">admin</option><option value="super_admin">super_admin</option></select>'
      : '';
    var creator = '<div class="toolbar">' +
      '<input id="admin-username" class="grow" placeholder="New admin username" autocomplete="off">' +
      '<input id="admin-password" class="grow" type="password" placeholder="Password (min 12 characters)" autocomplete="new-password">' +
      roleSelect +
      '<button data-action="create-admin" class="primary">Add admin</button>' +
      '</div>';

    if (!data) {
      view.innerHTML = '<section class="card"><h2>Admin users</h2>' + creator + '<div class="empty">Loading…</div></section>';
      return;
    }

    var rows = data.admins.map(function (item) {
      var lock = item.isLocked
        ? '<span class="badge disabled">locked</span>'
        : (item.failedAttempts ? '<span class="small muted">' + esc(item.failedAttempts) + ' failed</span>' : '<span class="small muted">ok</span>');
      var statusButton = item.status === 'active'
        ? '<button data-action="admin-status" data-id="' + item.id + '" data-status="disabled">Disable</button>'
        : '<button data-action="admin-status" data-id="' + item.id + '" data-status="active">Enable</button>';
      return '<tr><td>' + esc(item.id) + '</td>' +
        '<td><strong>' + esc(item.username) + '</strong><div class="small muted">last login ' + esc(formatDate(item.lastLoginAt)) + '</div></td>' +
        '<td><span class="badge">' + esc(item.role) + '</span></td>' +
        '<td><span class="badge ' + esc(item.status) + '">' + esc(item.status) + '</span><div class="small muted">' + lock + '</div></td>' +
        '<td class="small">' + (item.lockedUntil ? esc(formatDate(item.lockedUntil)) : '—') + '</td>' +
        '<td><div class="actions">' +
        '<button data-action="unlock-admin" data-id="' + item.id + '">Reset lock</button>' +
        '<button data-action="reset-password" data-id="' + item.id + '">Reset password</button>' +
        statusButton +
        '<button class="danger" data-action="delete-admin" data-id="' + item.id + '">Delete</button>' +
        '</div></td></tr>';
    }).join('');

    view.innerHTML = '<section class="card"><h2>Admin users</h2>' +
      '<p class="small muted">Passwords are hashed with PBKDF2. Five failed logins lock an account for 15 minutes.</p>' +
      creator +
      '<table><thead><tr><th>ID</th><th>Username</th><th>Role</th><th>Status</th><th>Locked until</th><th>Actions</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></section>';
  }

  function loadAdmins() {
    return api('/api/admin/admins').then(function (data) {
      state.admins = data;
      if (state.view === 'admins') renderAdmins();
    });
  }

  function handleAdminsAction(action, target) {
    if (action === 'create-admin') {
      var newUsername = document.getElementById('admin-username').value.trim();
      var newPassword = document.getElementById('admin-password').value;
      var roleField = document.getElementById('admin-role');
      var createPayload = { username: newUsername, password: newPassword };
      if (roleField) createPayload.role = roleField.value;
      target.disabled = true;
      guard(api('/api/admin/admins', {
        method: 'POST',
        body: JSON.stringify(createPayload)
      }).then(function (result) {
        toast('Created ' + result.admin.role + ' ' + result.admin.username + '.');
        return loadAdmins();
      }).then(function () { target.disabled = false; }));
      return true;
    }
    if (action === 'unlock-admin') {
      var unlockId = target.getAttribute('data-id');
      guard(api('/api/admin/admins/' + unlockId + '/unlock', { method: 'POST' }).then(function (result) {
        toast(result.message);
        return loadAdmins();
      }));
      return true;
    }
    if (action === 'reset-password') {
      var resetId = target.getAttribute('data-id');
      var resetValue = window.prompt('Enter a new password (min 12 characters):');
      if (!resetValue) return true;
      guard(api('/api/admin/admins/' + resetId + '/password', {
        method: 'POST',
        body: JSON.stringify({ password: resetValue })
      }).then(function (result) {
        toast(result.message);
        return loadAdmins();
      }));
      return true;
    }
    if (action === 'admin-status') {
      var statusId = target.getAttribute('data-id');
      var nextStatus = target.getAttribute('data-status');
      guard(api('/api/admin/admins/' + statusId + '/status', {
        method: 'POST',
        body: JSON.stringify({ status: nextStatus })
      }).then(function (result) {
        toast(result.message);
        return loadAdmins();
      }));
      return true;
    }
    if (action === 'delete-admin') {
      var deleteId = target.getAttribute('data-id');
      if (!window.confirm('Delete admin ' + deleteId + '? This cannot be undone.')) return true;
      guard(api('/api/admin/admins/' + deleteId, { method: 'DELETE' }).then(function (result) {
        toast(result.message);
        return loadAdmins();
      }));
      return true;
    }
    return false;
  }`;
