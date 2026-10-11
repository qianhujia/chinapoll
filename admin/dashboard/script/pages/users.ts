// Users page: manage public accounts.

export const scriptUsers = `  function renderUsers() {
    var view = document.getElementById('view');
    var data = state.users;
    var statusSelect = ['all', 'active', 'disabled', 'locked'].map(function (value) {
      return '<option value="' + value + '"' + (state.userStatus === value ? ' selected' : '') + '>' + value + '</option>';
    }).join('');
    var toolbar = '<div class="toolbar">' +
      '<input id="user-query" class="grow" placeholder="Search username" value="' + esc(state.userQuery) + '">' +
      '<select id="user-status" class="grow">' + statusSelect + '</select>' +
      '<button data-action="search-users" class="primary">Search</button>' +
      '</div>';

    if (!data) {
      view.innerHTML = '<section class="card"><h2>Users</h2>' + toolbar + '<div class="empty">Loading...</div></section>';
      return;
    }

    var rows = data.users.length
      ? data.users.map(function (item) {
          var lock = item.isLocked
            ? '<span class="badge disabled">locked</span>'
            : (item.failedAttempts ? '<span class="small muted">' + esc(item.failedAttempts) + ' failed</span>' : '<span class="small muted">ok</span>');
          var statusButton = item.status === 'active'
            ? '<button data-action="user-status" data-id="' + item.id + '" data-status="disabled">Disable</button>'
            : '<button data-action="user-status" data-id="' + item.id + '" data-status="active">Enable</button>';
          var unlockButton = (item.isLocked || item.failedAttempts)
            ? '<button data-action="unlock-user" data-id="' + item.id + '">Reset lock</button>'
            : '';
          return '<tr><td>' + esc(item.id) + '</td>' +
            '<td><strong>' + esc(item.username) + '</strong><div class="small muted">registered ' + esc(formatDate(item.createdAt)) + '</div></td>' +
            '<td><span class="badge ' + esc(item.status) + '">' + esc(item.status) + '</span><div class="small muted">' + lock + '</div></td>' +
            '<td class="small">' + esc(formatDate(item.lastLoginAt)) + '</td>' +
            '<td><div class="actions">' + unlockButton + statusButton +
            '<button class="danger" data-action="delete-user" data-id="' + item.id + '">Delete</button>' +
            '</div></td></tr>';
        }).join('')
      : '<tr><td colspan="6"><div class="empty">No users match this filter.</div></td></tr>';

    view.innerHTML = '<section class="card"><h2>Users</h2>' +
      '<p class="small muted">Public accounts sign in with a username and password only, and there is no password recovery. Disabling an account revokes its sessions. Deleting keeps the user&#39;s polls and comments but detaches them from the account.</p>' +
      toolbar +
      '<table><thead><tr><th>ID</th><th>Username</th><th>Status</th><th>Last login</th><th>Actions</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>' +
      '<div class="pager">' +
      '<span>Page ' + esc(data.page) + ' of ' + esc(data.totalPages) + ' &middot; ' + esc(data.total) + ' total</span>' +
      '<button data-action="user-page" data-dir="-1"' + (data.page <= 1 ? ' disabled' : '') + '>Previous</button>' +
      '<button data-action="user-page" data-dir="1"' + (data.page >= data.totalPages ? ' disabled' : '') + '>Next</button>' +
      '</div></section>';
  }

  function loadUsers() {
    var path = '/api/admin/users?page=' + state.userPage +
      '&status=' + encodeURIComponent(state.userStatus) +
      '&q=' + encodeURIComponent(state.userQuery);
    return api(path).then(function (data) {
      state.users = data;
      if (state.view === 'users') renderUsers();
    });
  }

  function handleUsersAction(action, target) {
    if (action === 'search-users') {
      state.userQuery = document.getElementById('user-query').value.trim();
      state.userStatus = document.getElementById('user-status').value;
      state.userPage = 1; state.users = null;
      renderUsers();
      guard(loadUsers());
      return true;
    }
    if (action === 'user-page') {
      state.userPage = Math.max(1, state.userPage + Number(target.getAttribute('data-dir')));
      state.users = null;
      renderUsers();
      guard(loadUsers());
      return true;
    }
    if (action === 'user-status') {
      var userStatusId = target.getAttribute('data-id');
      var userNextStatus = target.getAttribute('data-status');
      guard(api('/api/admin/users/' + userStatusId + '/status', {
        method: 'POST',
        body: JSON.stringify({ status: userNextStatus })
      }).then(function (result) {
        toast(result.message);
        return loadUsers();
      }));
      return true;
    }
    if (action === 'unlock-user') {
      var unlockUserId = target.getAttribute('data-id');
      guard(api('/api/admin/users/' + unlockUserId + '/unlock', { method: 'POST' }).then(function (result) {
        toast(result.message);
        return loadUsers();
      }));
      return true;
    }
    if (action === 'delete-user') {
      var deleteUserId = target.getAttribute('data-id');
      if (!window.confirm('Delete user ' + deleteUserId + '? Their polls and comments are kept but detached. This cannot be undone.')) return true;
      guard(api('/api/admin/users/' + deleteUserId, { method: 'DELETE' }).then(function (result) {
        toast(result.message);
        return loadUsers();
      }));
      return true;
    }
    return false;
  }`;
