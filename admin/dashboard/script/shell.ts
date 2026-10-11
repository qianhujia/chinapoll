// Dashboard shell, navigation, and event wiring.

export const scriptShell = `  function renderShell() {
    var items = ['overview', 'polls', 'comments', 'users', 'admins'];
    if (isSuperAdmin()) items.push('audit');
    items.push('settings');
    var nav = items.map(function (item) {
      return '<a href="' + pathForView(item) + '" data-action="tab" data-view="' + item + '" class="' + (state.view === item ? 'active' : '') + '">' +
        item.charAt(0).toUpperCase() + item.slice(1) + '</a>';
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

  function loadCurrent() {
    if (state.view === 'overview') return loadOverview();
    if (state.view === 'polls') return loadPolls();
    if (state.view === 'comments') return loadComments();
    if (state.view === 'users') return loadUsers();
    if (state.view === 'admins') return loadAdmins();
    if (state.view === 'audit') return loadAudit();
    return loadSettings();
  }

  function showView() {
    if (!document.getElementById('view')) renderShell();
    if (state.view === 'overview') renderOverview();
    else if (state.view === 'polls') renderPolls();
    else if (state.view === 'comments') renderComments();
    else if (state.view === 'users') renderUsers();
    else if (state.view === 'admins') renderAdmins();
    else if (state.view === 'audit') renderAudit();
    else renderSettings();
  }

  app.addEventListener('click', function (event) {
    var target = event.target.closest('[data-action]');
    if (!target) return;
    var action = target.getAttribute('data-action');

    if (action === 'tab') {
      event.preventDefault();
      navigateToView(target.getAttribute('data-view'));
      return;
    }
    if (action === 'refresh') {
      state.overview = null; state.polls = null;
      state.comments = null; state.admins = null; state.audit = null; state.settings = null;
      showView();
      guard(loadCurrent());
      return;
    }
    if (action === 'logout') {
      guard(api('/api/admin/session', { method: 'DELETE' }).then(function () {
        state.user = null;
        window.history.replaceState({}, '', '/');
        boot();
      }));
      return;
    }
    if (handlePollsAction(action, target)) return;
    if (handleSettingsAction(action, target)) return;
    if (handleCommentsAction(action, target)) return;
    if (handleUsersAction(action, target)) return;
    if (handleAdminsAction(action, target)) return;
    if (handleAuditAction(action, target)) return;
  });

  app.addEventListener('change', function (event) {
    var target = event.target;
    if (target && target.getAttribute && target.getAttribute('data-action') === 'poll-status') {
      handlePollsChange(target);
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

      state.view = allowedView(viewFromPath(window.location.pathname));
      // Normalize aliases and disallowed paths (for example "/index.html" or
      // "/audit" for a regular admin) to the canonical URL for the resolved view.
      window.history.replaceState({}, '', pathForView(state.view));
      state.overview = null; state.polls = null;
      state.comments = null; state.admins = null; state.audit = null; state.settings = null;
      showResolvedView();
    }).catch(function (error) {
      renderLogin(error && error.message ? error.message : 'Unable to reach the admin API.');
    });
  }

  // Keep the view in sync when the user navigates with the browser back and
  // forward buttons. Login and setup screens have no URL of their own, so they
  // stay put until the user signs in.
  window.addEventListener('popstate', function () {
    if (!state.user) return;
    state.view = allowedView(viewFromPath(window.location.pathname));
    showResolvedView();
  });

  boot();`;
