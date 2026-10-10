// Self-contained admin dashboard served by the admin Worker at "/".
// The markup, styles, and script are embedded so the Worker has no build step
// and no runtime dependencies. The script uses string concatenation rather than
// template literals to avoid clashing with the surrounding template string.

export function renderDashboard(nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>ChinaPoll Admin</title>
<style nonce="${nonce}">
:root{--bg:#0f172a;--panel:#1e293b;--panel-2:#273449;--text:#e2e8f0;--muted:#94a3b8;--accent:#3b82f6;--ok:#22c55e;--warn:#f59e0b;--err:#ef4444;--border:#334155;}
*{box-sizing:border-box;}
body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:15px;line-height:1.5;}
a{color:var(--accent);}
button{font:inherit;cursor:pointer;border-radius:8px;border:1px solid var(--border);background:var(--panel-2);color:var(--text);padding:7px 12px;transition:filter .15s;}
button:hover{filter:brightness(1.15);}
button:disabled{opacity:.5;cursor:not-allowed;}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff;}
button.ok{background:#166534;border-color:#166534;color:#dcfce7;}
button.danger{background:#7f1d1d;border-color:#7f1d1d;color:#fee2e2;}
input,select,textarea{font:inherit;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:7px 10px;width:100%;}
label{display:block;color:var(--muted);font-size:13px;margin-bottom:4px;}
.layout{display:flex;min-height:100vh;}
.sidebar{width:220px;flex:0 0 220px;background:var(--panel);border-right:1px solid var(--border);padding:18px 14px;display:flex;flex-direction:column;gap:10px;position:sticky;top:0;height:100vh;overflow-y:auto;}
.brand{font-weight:700;font-size:17px;letter-spacing:.2px;padding:0 8px;}
.brand span{color:var(--accent);}
.sidebar .nav{display:flex;flex-direction:column;gap:4px;flex:1;}
.sidebar .nav button{text-align:left;background:transparent;border-color:transparent;padding:9px 12px;}
.sidebar .nav button:hover{background:var(--panel-2);}
.sidebar .nav button.active{background:var(--accent);border-color:var(--accent);color:#fff;}
.sidebar .footer{display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--border);padding-top:12px;}
.sidebar .who{color:var(--muted);font-size:13px;padding:0 8px;word-break:break-word;}
.content{flex:1;min-width:0;}
main{max-width:1080px;margin:0 auto;padding:22px;}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;}
.card{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:16px;}
.stat .value{font-size:26px;font-weight:700;}
.stat .label{color:var(--muted);font-size:13px;}
.card h2{margin:0 0 12px;font-size:16px;}
.toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:14px;}
.toolbar .grow{flex:1;min-width:180px;}
table{width:100%;border-collapse:collapse;}
th,td{text-align:left;padding:10px 8px;border-bottom:1px solid var(--border);vertical-align:top;}
th{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.4px;}
tr:hover td{background:rgba(255,255,255,.02);}
.badge{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;border:1px solid var(--border);}
.badge.pending{background:#78350f;border-color:#78350f;color:#fde68a;}
.badge.open{background:#14532d;border-color:#14532d;color:#bbf7d0;}
.badge.closed{background:#3f3f46;border-color:#3f3f46;color:#e4e4e7;}
.badge.archived{background:#1e3a8a;border-color:#1e3a8a;color:#bfdbfe;}
.muted{color:var(--muted);}
.small{font-size:13px;}
.actions{display:flex;gap:6px;flex-wrap:wrap;}
.login{max-width:360px;margin:12vh auto;padding:26px;background:var(--panel);border:1px solid var(--border);border-radius:14px;}
.login h1{margin:0 0 6px;font-size:20px;}
.login p{color:var(--muted);margin:0 0 18px;font-size:14px;}
.login button{width:100%;margin-top:12px;}
.error{color:var(--err);font-size:13px;min-height:18px;margin-top:8px;}
.toast{position:fixed;right:20px;bottom:20px;background:var(--panel-2);border:1px solid var(--border);border-left:4px solid var(--accent);padding:12px 16px;border-radius:10px;max-width:340px;box-shadow:0 10px 30px rgba(0,0,0,.4);}
.toast.err{border-left-color:var(--err);}
.setting-row{display:grid;grid-template-columns:220px 1fr auto;gap:12px;align-items:end;padding:12px 0;border-bottom:1px solid var(--border);}
.setting-row .meta{color:var(--muted);font-size:12px;grid-column:1/2;}
.pager{display:flex;gap:10px;align-items:center;justify-content:flex-end;margin-top:14px;}
.pager span{color:var(--muted);font-size:13px;}
.empty{color:var(--muted);padding:20px 0;text-align:center;}
.desc{max-width:520px;color:var(--muted);font-size:13px;}
.turnstile{margin-top:12px;min-height:65px;}
.pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;white-space:pre-wrap;word-break:break-word;color:var(--muted);}
.badge.active{background:#14532d;border-color:#14532d;color:#bbf7d0;}
.badge.disabled{background:#7f1d1d;border-color:#7f1d1d;color:#fee2e2;}
@media(max-width:720px){.setting-row{grid-template-columns:1fr;}.layout{flex-direction:column;}.sidebar{width:auto;height:auto;position:static;flex-direction:row;flex-wrap:wrap;align-items:center;gap:8px;}.sidebar .brand{width:100%;margin-bottom:6px;}.sidebar .nav{flex-direction:row;flex-wrap:wrap;flex:0 0 auto;width:100%;}.sidebar .footer{border-top:none;padding-top:0;flex-direction:row;flex-wrap:wrap;width:100%;}.sidebar .who{width:100%;}}
</style>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" async defer></script>
</head>
<body>
<div id="app"></div>
<div id="toast-copy"></div>
<script nonce="${nonce}">
(function () {
  'use strict';
  var app = document.getElementById('app');
  var state = {
    view: 'overview',
    user: null,
    session: null,
    turnstile: { enabled: false, siteKey: '' },
    overview: null,
    proposals: null,
    polls: null,
    comments: null,
    admins: null,
    audit: null,
    settings: null,
    proposalStatus: 'pending',
    proposalQuery: '',
    pollStatus: 'all',
    pollQuery: '',
    commentQuery: '',
    commentPollId: '',
    auditAction: '',
    auditQuery: '',
    proposalPage: 1,
    pollPage: 1,
    commentPage: 1,
    auditPage: 1
  };

  function esc(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function isSuperAdmin() {
    return Boolean(state.user && state.user.role === 'super_admin');
  }

  function api(path, options) {
    var config = options || {};
    config.credentials = 'same-origin';
    if (!config.headers) config.headers = {};
    if (config.body) config.headers['content-type'] = 'application/json';
    return fetch(path, config).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (!response.ok) {
          var error = new Error(data && data.message ? data.message : 'Request failed (' + response.status + ')');
          error.status = response.status;
          throw error;
        }
        return data;
      });
    });
  }

  var toastTimer = null;
  function toast(message, isError) {
    var host = document.getElementById('toast-copy');
    host.innerHTML = '<div class="toast' + (isError ? ' err' : '') + '">' + esc(message) + '</div>';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { host.innerHTML = ''; }, 4200);
  }

  function formatDate(value) {
    if (!value) return '—';
    var date = new Date(value);
    if (isNaN(date.getTime())) return '—';
    return date.toISOString().replace('T', ' ').slice(0, 16);
  }

  function waitForTurnstile(callback) {
    var attempts = 0;
    (function poll() {
      if (window.turnstile && typeof window.turnstile.render === 'function') {
        callback(window.turnstile);
        return;
      }
      attempts += 1;
      if (attempts < 120) setTimeout(poll, 100);
    })();
  }

  function renderTurnstileWidget(siteKey, onToken) {
    var slot = document.getElementById('turnstile-slot');
    if (!slot) return;
    waitForTurnstile(function (turnstile) {
      if (!document.getElementById('turnstile-slot')) return;
      try {
        turnstile.render(slot, {
          sitekey: siteKey,
          callback: onToken,
          'error-callback': function () { onToken(''); },
          'expired-callback': function () { onToken(''); }
        });
      } catch (error) {
        // The widget fails closed; the server still requires a valid token.
      }
    });
  }

  function renderLogin(message) {
    var turnstile = state.turnstile || { enabled: false, siteKey: '' };
    var turnstileField = turnstile.enabled ? '<div class="turnstile" id="turnstile-slot"></div>' : '';
    app.innerHTML = '<form class="login" id="login-form">' +
      '<h1>ChinaPoll <span style="color:var(--accent)">Admin</span></h1>' +
      '<p>Sign in with your admin username and password.</p>' +
      '<label for="login-username">Username</label>' +
      '<input id="login-username" autocomplete="username" autofocus>' +
      '<label for="login-password" style="margin-top:12px">Password</label>' +
      '<input id="login-password" type="password" autocomplete="current-password">' +
      turnstileField +
      '<button class="primary" type="submit">Sign in</button>' +
      '<div class="error" id="login-error">' + esc(message || '') + '</div>' +
      '</form>';

    var turnstileToken = '';
    if (turnstile.enabled) {
      renderTurnstileWidget(turnstile.siteKey, function (token) { turnstileToken = token; });
    }

    document.getElementById('login-form').addEventListener('submit', function (event) {
      event.preventDefault();
      var username = document.getElementById('login-username').value.trim();
      var password = document.getElementById('login-password').value;
      var errorBox = document.getElementById('login-error');
      if (!username || !password) {
        errorBox.textContent = 'Username and password are required.';
        return;
      }
      if (turnstile.enabled && !turnstileToken) {
        errorBox.textContent = 'Please complete the Turnstile verification.';
        return;
      }
      var payload = { username: username, password: password };
      if (turnstile.enabled) payload.turnstileToken = turnstileToken;
      api('/api/admin/session', { method: 'POST', body: JSON.stringify(payload) })
        .then(function () { boot(); })
        .catch(function (error) { errorBox.textContent = error.message; });
    });
  }

  function renderSetup(message) {
    app.innerHTML = '<form class="login" id="setup-form">' +
      '<h1>Create first admin</h1>' +
      '<p>No admin users exist yet. Create the first account; it becomes the super admin.</p>' +
      '<label for="setup-username">Username</label>' +
      '<input id="setup-username" autocomplete="username" autofocus>' +
      '<label for="setup-password" style="margin-top:12px">Password (min 12 characters)</label>' +
      '<input id="setup-password" type="password" autocomplete="new-password">' +
      '<button class="primary" type="submit">Create admin</button>' +
      '<div class="error" id="setup-error">' + esc(message || '') + '</div>' +
      '</form>';
    document.getElementById('setup-form').addEventListener('submit', function (event) {
      event.preventDefault();
      var errorBox = document.getElementById('setup-error');
      var payload = {
        username: document.getElementById('setup-username').value.trim(),
        password: document.getElementById('setup-password').value
      };
      api('/api/admin/setup', { method: 'POST', body: JSON.stringify(payload) })
        .then(function () { boot(); })
        .catch(function (error) { errorBox.textContent = error.message; });
    });
  }

  function renderShell() {
    var items = ['overview', 'proposals', 'polls', 'comments', 'admins'];
    if (isSuperAdmin()) items.push('audit');
    items.push('settings');
    var nav = items.map(function (item) {
      return '<button data-action="tab" data-view="' + item + '" class="' + (state.view === item ? 'active' : '') + '">' +
        item.charAt(0).toUpperCase() + item.slice(1) + '</button>';
    }).join('');
    var who = state.user
      ? esc(state.user.username) + ' · ' + esc(state.user.role === 'super_admin' ? 'super admin' : 'admin')
      : '';
    app.innerHTML = '<div class="layout">' +
      '<aside class="sidebar">' +
      '<div class="brand">ChinaPoll <span>Admin</span></div>' +
      '<nav class="nav">' + nav + '</nav>' +
      '<div class="footer">' +
      '<div class="who">' + who + '</div>' +
      '<button data-action="refresh">Refresh</button>' +
      '<button data-action="logout">Sign out</button>' +
      '</div>' +
      '</aside>' +
      '<div class="content"><main id="view"></main></div>' +
      '</div>';
  }

  function statCard(value, label) {
    return '<div class="card stat"><div class="value">' + esc(value) + '</div><div class="label">' + esc(label) + '</div></div>';
  }

  function renderOverview() {
    var view = document.getElementById('view');
    if (!state.overview) {
      view.innerHTML = '<div class="empty">Loading…</div>';
      return;
    }
    var o = state.overview;
    var recent = o.recentPending.length
      ? '<table><thead><tr><th>ID</th><th>Title</th><th>Mode</th><th>Submitted</th></tr></thead><tbody>' +
        o.recentPending.map(function (row) {
          return '<tr><td>' + esc(row.id) + '</td><td>' + esc(row.title || '(no title)') + '</td>' +
            '<td>' + esc(row.mode === 1 ? 'deadline' : 'evergreen') + '</td>' +
            '<td class="small">' + esc(formatDate(row.createdAt)) + '</td></tr>';
        }).join('') + '</tbody></table>'
      : '<div class="empty">No pending submissions.</div>';

    view.innerHTML =
      '<section class="grid">' +
      statCard(o.pending, 'Pending submissions') +
      statCard(o.open, 'Open polls') +
      statCard(o.closed, 'Closed polls') +
      statCard(o.archived, 'Archived polls') +
      statCard(o.votes, 'Total votes') +
      statCard(o.comments, 'Total comments') +
      statCard(o.identities, 'Proposal identities') +
      statCard(o.adminUsers, 'Admin users') +
      (isSuperAdmin() ? statCard(o.auditEntries, 'Audit entries') : '') +
      statCard(o.settings, 'Settings rows') +
      '</section>' +
      '<section class="card" style="margin-top:18px"><h2>Latest submissions</h2>' + recent + '</section>';
  }

  function statusOptions(selected, includeAll, includePending) {
    var values = [];
    if (includePending) values.push('pending');
    values.push('open', 'closed', 'archived');
    if (includeAll) values.push('all');
    return values.map(function (value) {
      return '<option value="' + value + '"' + (value === selected ? ' selected' : '') + '>' + value + '</option>';
    }).join('');
  }

  function renderProposals() {
    var view = document.getElementById('view');
    var data = state.proposals;
    var toolbar = '<div class="toolbar">' +
      '<select id="proposal-status" class="grow">' + statusOptions(state.proposalStatus, true, true) + '</select>' +
      '<input id="proposal-query" class="grow" placeholder="Search titles…" value="' + esc(state.proposalQuery) + '">' +
      '<button data-action="search-proposals" class="primary">Search</button>' +
      '</div>';

    if (!data) {
      view.innerHTML = '<section class="card"><h2>Submissions</h2>' + toolbar + '<div class="empty">Loading…</div></section>';
      return;
    }

    var rows = data.proposals.length
      ? data.proposals.map(function (item) {
          var actions = item.status === 'pending'
            ? '<div class="actions">' +
              '<button class="ok" data-action="approve" data-id="' + item.id + '">Approve</button>' +
              '<button class="danger" data-action="reject" data-id="' + item.id + '">Reject</button>' +
              '</div>'
            : '<span class="muted small">Reviewed</span>';
          return '<tr><td>' + esc(item.id) + '</td>' +
            '<td><strong>' + esc(item.title || '(no title)') + '</strong>' +
            '<div class="desc">' + esc(item.description || '') + '</div></td>' +
            '<td><span class="badge ' + esc(item.status) + '">' + esc(item.status) + '</span><div class="small muted">' + esc(item.mode) + '</div></td>' +
            '<td class="small">' + esc(item.submitter || '(anonymous)') + '<div class="muted">' + esc(formatDate(item.createdAt)) + '</div></td>' +
            '<td>' + actions + '</td></tr>';
        }).join('')
      : '<tr><td colspan="5"><div class="empty">No submissions match this filter.</div></td></tr>';

    view.innerHTML = '<section class="card"><h2>Submissions</h2>' + toolbar +
      '<table><thead><tr><th>ID</th><th>Title</th><th>Status</th><th>Submitter</th><th>Actions</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>' +
      '<div class="pager">' +
      '<span>Page ' + esc(data.page) + ' of ' + esc(data.totalPages) + ' · ' + esc(data.total) + ' total</span>' +
      '<button data-action="proposal-page" data-dir="-1"' + (data.page <= 1 ? ' disabled' : '') + '>Previous</button>' +
      '<button data-action="proposal-page" data-dir="1"' + (data.page >= data.totalPages ? ' disabled' : '') + '>Next</button>' +
      '</div></section>';
  }

  function renderPolls() {
    var view = document.getElementById('view');
    var data = state.polls;
    var toolbar = '<div class="toolbar">' +
      '<select id="poll-status" class="grow">' + statusOptions(state.pollStatus, true, true) + '</select>' +
      '<input id="poll-query" class="grow" placeholder="Search titles…" value="' + esc(state.pollQuery) + '">' +
      '<button data-action="search-polls" class="primary">Search</button>' +
      '</div>';

    if (!data) {
      view.innerHTML = '<section class="card"><h2>Polls</h2>' + toolbar + '<div class="empty">Loading…</div></section>';
      return;
    }

    var rows = data.polls.length
      ? data.polls.map(function (item) {
          var selector = '<select class="poll-status-select" data-action="poll-status" data-id="' + item.id + '">' +
            statusOptions(item.status, false, true) + '</select>';
          return '<tr><td>' + esc(item.id) + '</td>' +
            '<td><strong>' + esc(item.title || '(no title)') + '</strong>' +
            '<div class="small muted">' + esc(item.mode) + '</div></td>' +
            '<td><span class="badge ' + esc(item.status) + '">' + esc(item.status) + '</span></td>' +
            '<td class="small">' + esc(item.counts.approve) + ' / ' + esc(item.counts.neutral) + ' / ' + esc(item.counts.oppose) + '</td>' +
            '<td style="min-width:150px">' + selector + '</td></tr>';
        }).join('')
      : '<tr><td colspan="5"><div class="empty">No polls match this filter.</div></td></tr>';

    view.innerHTML = '<section class="card"><h2>Polls</h2>' + toolbar +
      '<table><thead><tr><th>ID</th><th>Title</th><th>Status</th><th>Approve / Neutral / Oppose</th><th>Change status</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>' +
      '<div class="pager">' +
      '<span>Page ' + esc(data.page) + ' of ' + esc(data.totalPages) + ' · ' + esc(data.total) + ' total</span>' +
      '<button data-action="poll-page" data-dir="-1"' + (data.page <= 1 ? ' disabled' : '') + '>Previous</button>' +
      '<button data-action="poll-page" data-dir="1"' + (data.page >= data.totalPages ? ' disabled' : '') + '>Next</button>' +
      '</div></section>';
  }

  function renderSettings() {
    var view = document.getElementById('view');
    var data = state.settings;
    if (!data) {
      view.innerHTML = '<section class="card"><h2>Settings</h2><div class="empty">Loading…</div></section>';
      return;
    }

    var rows = data.settings.map(function (item) {
      var type = item.isSecret ? 'password' : 'text';
      var value = item.isSecret ? '' : (item.value === null ? '' : item.value);
      var placeholder = item.isSecret ? 'Leave blank to keep the current secret' : 'Not set';
      return '<div class="setting-row">' +
        '<div><label for="setting-' + esc(item.key) + '">' + esc(item.key) + '</label>' +
        '<div class="meta">' + (item.isSecret ? 'secret · ' : '') + 'default: ' + esc(item.defaultValue) + '</div></div>' +
        '<div>' +
        '<input id="setting-' + esc(item.key) + '" type="' + type + '" data-key="' + esc(item.key) + '" value="' + esc(value) + '" placeholder="' + esc(placeholder) + '">' +
        '<div class="small muted">' + (item.isSet ? ('last updated ' + esc(formatDate(item.updatedAt))) : 'not set in database') + '</div>' +
        '</div>' +
        '<div><button class="primary" data-action="save-setting" data-key="' + esc(item.key) + '">Save</button></div>' +
        '</div>';
    }).join('');

    view.innerHTML = '<section class="card"><h2>Application settings</h2>' +
      '<p class="small muted">Values are validated with the same rules the public Worker API enforces.</p>' +
      '<div class="toolbar"><button data-action="initialize-settings">Insert missing defaults</button></div>' +
      rows + '</section>';
  }

  function renderComments() {
    var view = document.getElementById('view');
    var data = state.comments;
    var toolbar = '<div class="toolbar">' +
      '<input id="comment-poll" class="grow" placeholder="Filter by poll ID" value="' + esc(state.commentPollId) + '">' +
      '<input id="comment-query" class="grow" placeholder="Search comment text…" value="' + esc(state.commentQuery) + '">' +
      '<button data-action="search-comments" class="primary">Search</button>' +
      '</div>';

    if (!data) {
      view.innerHTML = '<section class="card"><h2>Comments</h2>' + toolbar + '<div class="empty">Loading…</div></section>';
      return;
    }

    var rows = data.comments.length
      ? data.comments.map(function (item) {
          return '<tr><td>' + esc(item.id) + '</td>' +
            '<td class="desc">' + esc(item.comment) + '</td>' +
            '<td class="small">' + esc(item.pollId) + '<div class="muted">' + esc(item.pollTitle || '(unknown poll)') + '</div></td>' +
            '<td class="small">' + esc(formatDate(item.createdAt)) + '</td>' +
            '<td><button class="danger" data-action="delete-comment" data-id="' + item.id + '">Delete</button></td></tr>';
        }).join('')
      : '<tr><td colspan="5"><div class="empty">No comments match this filter.</div></td></tr>';

    view.innerHTML = '<section class="card"><h2>Comments</h2>' + toolbar +
      '<table><thead><tr><th>ID</th><th>Comment</th><th>Poll</th><th>Created</th><th>Action</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>' +
      '<div class="pager">' +
      '<span>Page ' + esc(data.page) + ' of ' + esc(data.totalPages) + ' · ' + esc(data.total) + ' total</span>' +
      '<button data-action="comment-page" data-dir="-1"' + (data.page <= 1 ? ' disabled' : '') + '>Previous</button>' +
      '<button data-action="comment-page" data-dir="1"' + (data.page >= data.totalPages ? ' disabled' : '') + '>Next</button>' +
      '</div></section>';
  }

  function renderAdmins() {
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

  function renderAudit() {
    var view = document.getElementById('view');
    var data = state.audit;
    var actionOptions = '<option value="">All actions</option>';
    if (data) {
      actionOptions += data.actions.map(function (action) {
        return '<option value="' + esc(action) + '"' + (state.auditAction === action ? ' selected' : '') + '>' + esc(action) + '</option>';
      }).join('');
    }
    var toolbar = '<div class="toolbar">' +
      '<select id="audit-action" class="grow">' + actionOptions + '</select>' +
      '<input id="audit-query" class="grow" placeholder="Search actor, target, details…" value="' + esc(state.auditQuery) + '">' +
      '<button data-action="search-audit" class="primary">Search</button>' +
      '</div>';

    if (!data) {
      view.innerHTML = '<section class="card"><h2>Audit log</h2>' + toolbar + '<div class="empty">Loading…</div></section>';
      return;
    }

    var rows = data.entries.length
      ? data.entries.map(function (item) {
          return '<tr><td class="small">' + esc(formatDate(item.createdAt)) + '</td>' +
            '<td class="small">' + esc(item.actorUsername || '(system)') + '</td>' +
            '<td><strong>' + esc(item.action) + '</strong></td>' +
            '<td class="small">' + esc(item.targetType || '') + ' ' + esc(item.targetId || '') + '</td>' +
            '<td class="pre">' + esc(item.details ? JSON.stringify(item.details) : '') + '</td></tr>';
        }).join('')
      : '<tr><td colspan="5"><div class="empty">No audit entries match this filter.</div></td></tr>';

    view.innerHTML = '<section class="card"><h2>Audit log</h2>' +
      '<p class="small muted">Admin actions, including sign-ins. Client IP addresses are never recorded.</p>' +
      toolbar +
      '<table><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th><th>Details</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>' +
      '<div class="pager">' +
      '<span>Page ' + esc(data.page) + ' of ' + esc(data.totalPages) + ' · ' + esc(data.total) + ' total</span>' +
      '<button data-action="audit-page" data-dir="-1"' + (data.page <= 1 ? ' disabled' : '') + '>Previous</button>' +
      '<button data-action="audit-page" data-dir="1"' + (data.page >= data.totalPages ? ' disabled' : '') + '>Next</button>' +
      '</div></section>';
  }

  function guard(promise) {
    return promise.catch(function (error) {
      if (error && error.status === 401) {
        renderLogin('Your session expired. Please sign in again.');
        return;
      }
      toast(error && error.message ? error.message : 'Request failed.', true);
    });
  }

  function loadOverview() {
    return api('/api/admin/overview').then(function (data) {
      state.overview = data.overview;
      if (state.view === 'overview') renderOverview();
    });
  }

  function loadProposals() {
    var path = '/api/admin/proposals?status=' + encodeURIComponent(state.proposalStatus) +
      '&page=' + state.proposalPage + '&q=' + encodeURIComponent(state.proposalQuery);
    return api(path).then(function (data) {
      state.proposals = data;
      if (state.view === 'proposals') renderProposals();
    });
  }

  function loadPolls() {
    var path = '/api/admin/polls?status=' + encodeURIComponent(state.pollStatus) +
      '&page=' + state.pollPage + '&q=' + encodeURIComponent(state.pollQuery);
    return api(path).then(function (data) {
      state.polls = data;
      if (state.view === 'polls') renderPolls();
    });
  }

  function loadSettings() {
    return api('/api/admin/settings').then(function (data) {
      state.settings = data;
      if (state.view === 'settings') renderSettings();
    });
  }

  function loadComments() {
    var path = '/api/admin/comments?page=' + state.commentPage +
      '&q=' + encodeURIComponent(state.commentQuery) +
      '&pollId=' + encodeURIComponent(state.commentPollId);
    return api(path).then(function (data) {
      state.comments = data;
      if (state.view === 'comments') renderComments();
    });
  }

  function loadAdmins() {
    return api('/api/admin/admins').then(function (data) {
      state.admins = data;
      if (state.view === 'admins') renderAdmins();
    });
  }

  function loadAudit() {
    var path = '/api/admin/audit?page=' + state.auditPage +
      '&action=' + encodeURIComponent(state.auditAction) +
      '&q=' + encodeURIComponent(state.auditQuery);
    return api(path).then(function (data) {
      state.audit = data;
      if (state.view === 'audit') renderAudit();
    });
  }

  function loadCurrent() {
    if (state.view === 'overview') return loadOverview();
    if (state.view === 'proposals') return loadProposals();
    if (state.view === 'polls') return loadPolls();
    if (state.view === 'comments') return loadComments();
    if (state.view === 'admins') return loadAdmins();
    if (state.view === 'audit') return loadAudit();
    return loadSettings();
  }

  function showView() {
    if (!document.getElementById('view')) renderShell();
    if (state.view === 'overview') renderOverview();
    else if (state.view === 'proposals') renderProposals();
    else if (state.view === 'polls') renderPolls();
    else if (state.view === 'comments') renderComments();
    else if (state.view === 'admins') renderAdmins();
    else if (state.view === 'audit') renderAudit();
    else renderSettings();
  }

  app.addEventListener('click', function (event) {
    var target = event.target.closest('[data-action]');
    if (!target) return;
    var action = target.getAttribute('data-action');

    if (action === 'tab') {
      state.view = target.getAttribute('data-view');
      renderShell();
      showView();
      guard(loadCurrent());
      return;
    }
    if (action === 'refresh') {
      state.overview = null; state.proposals = null; state.polls = null;
      state.comments = null; state.admins = null; state.audit = null; state.settings = null;
      showView();
      guard(loadCurrent());
      return;
    }
    if (action === 'logout') {
      guard(api('/api/admin/session', { method: 'DELETE' }).then(function () {
        state.user = null;
        boot();
      }));
      return;
    }
    if (action === 'approve' || action === 'reject') {
      var id = target.getAttribute('data-id');
      target.disabled = true;
      guard(api('/api/admin/proposals/' + id + '/' + action, { method: 'POST' }).then(function (result) {
        toast(result.message);
        return Promise.all([loadProposals(), loadOverview()]);
      }));
      return;
    }
    if (action === 'search-proposals') {
      state.proposalQuery = document.getElementById('proposal-query').value.trim();
      state.proposalStatus = document.getElementById('proposal-status').value;
      state.proposalPage = 1; state.proposals = null;
      renderProposals();
      guard(loadProposals());
      return;
    }
    if (action === 'proposal-page') {
      state.proposalPage = Math.max(1, state.proposalPage + Number(target.getAttribute('data-dir')));
      state.proposals = null;
      renderProposals();
      guard(loadProposals());
      return;
    }
    if (action === 'search-polls') {
      state.pollQuery = document.getElementById('poll-query').value.trim();
      state.pollStatus = document.getElementById('poll-status').value;
      state.pollPage = 1; state.polls = null;
      renderPolls();
      guard(loadPolls());
      return;
    }
    if (action === 'poll-page') {
      state.pollPage = Math.max(1, state.pollPage + Number(target.getAttribute('data-dir')));
      state.polls = null;
      renderPolls();
      guard(loadPolls());
      return;
    }
    if (action === 'save-setting') {
      var key = target.getAttribute('data-key');
      var input = document.getElementById('setting-' + key);
      var value = input.value;
      if (input.type === 'password' && value === '') {
        toast('Enter a new secret value or leave it unchanged.', true);
        return;
      }
      target.disabled = true;
      guard(api('/api/admin/settings/' + encodeURIComponent(key), {
        method: 'PUT',
        body: JSON.stringify({ value: value })
      }).then(function (result) {
        toast(result.message);
        return loadSettings();
      }).then(function () { target.disabled = false; }));
      return;
    }
    if (action === 'initialize-settings') {
      target.disabled = true;
      guard(api('/api/admin/settings/initialize', { method: 'POST' }).then(function (result) {
        toast(result.message);
        return loadSettings();
      }));
      return;
    }
    if (action === 'delete-comment') {
      var commentId = target.getAttribute('data-id');
      if (!window.confirm('Delete comment ' + commentId + '?')) return;
      target.disabled = true;
      guard(api('/api/admin/comments/' + commentId, { method: 'DELETE' }).then(function (result) {
        toast(result.message);
        return Promise.all([loadComments(), loadOverview()]);
      }));
      return;
    }
    if (action === 'search-comments') {
      state.commentPollId = document.getElementById('comment-poll').value.trim();
      state.commentQuery = document.getElementById('comment-query').value.trim();
      state.commentPage = 1; state.comments = null;
      renderComments();
      guard(loadComments());
      return;
    }
    if (action === 'comment-page') {
      state.commentPage = Math.max(1, state.commentPage + Number(target.getAttribute('data-dir')));
      state.comments = null;
      renderComments();
      guard(loadComments());
      return;
    }
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
      return;
    }
    if (action === 'unlock-admin') {
      var unlockId = target.getAttribute('data-id');
      guard(api('/api/admin/admins/' + unlockId + '/unlock', { method: 'POST' }).then(function (result) {
        toast(result.message);
        return loadAdmins();
      }));
      return;
    }
    if (action === 'reset-password') {
      var resetId = target.getAttribute('data-id');
      var resetValue = window.prompt('Enter a new password (min 12 characters):');
      if (!resetValue) return;
      guard(api('/api/admin/admins/' + resetId + '/password', {
        method: 'POST',
        body: JSON.stringify({ password: resetValue })
      }).then(function (result) {
        toast(result.message);
        return loadAdmins();
      }));
      return;
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
      return;
    }
    if (action === 'delete-admin') {
      var deleteId = target.getAttribute('data-id');
      if (!window.confirm('Delete admin ' + deleteId + '? This cannot be undone.')) return;
      guard(api('/api/admin/admins/' + deleteId, { method: 'DELETE' }).then(function (result) {
        toast(result.message);
        return loadAdmins();
      }));
      return;
    }
    if (action === 'search-audit') {
      state.auditAction = document.getElementById('audit-action').value;
      state.auditQuery = document.getElementById('audit-query').value.trim();
      state.auditPage = 1; state.audit = null;
      renderAudit();
      guard(loadAudit());
      return;
    }
    if (action === 'audit-page') {
      state.auditPage = Math.max(1, state.auditPage + Number(target.getAttribute('data-dir')));
      state.audit = null;
      renderAudit();
      guard(loadAudit());
      return;
    }
  });

  app.addEventListener('change', function (event) {
    var target = event.target;
    if (target && target.getAttribute && target.getAttribute('data-action') === 'poll-status') {
      var id = target.getAttribute('data-id');
      guard(api('/api/admin/polls/' + id + '/status', {
        method: 'POST',
        body: JSON.stringify({ status: target.value })
      }).then(function (result) {
        toast(result.message);
        return Promise.all([loadPolls(), loadOverview()]);
      }));
    }
  });

  function boot() {
    api('/api/admin/session').then(function (result) {
      state.session = result;
      state.turnstile = result.turnstile || { enabled: false, siteKey: '' };
      state.user = result.user || null;

      if (result.setupRequired) {
        renderSetup();
        return;
      }
      if (!result.authenticated) {
        renderLogin();
        return;
      }

      state.view = 'overview';
      state.overview = null; state.proposals = null; state.polls = null;
      state.comments = null; state.admins = null; state.audit = null; state.settings = null;
      renderShell();
      showView();
      guard(loadCurrent());
    }).catch(function (error) {
      renderLogin(error && error.message ? error.message : 'Unable to reach the admin API.');
    });
  }

  boot();
})();
</script>
</body>
</html>`;
}
