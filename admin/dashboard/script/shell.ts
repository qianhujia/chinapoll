// Dashboard shell, navigation, and event wiring.

export const scriptShell = `  // The Settings pages are listed under the Settings link while that section is
  // open, so every category is one click away.
  function renderSettingsSubNav() {
    return '<div class="subnav">' + SETTINGS_CATEGORIES.map(function (category) {
      var active = state.settingsCategory === category.id ? ' active' : '';
      return '<a href="' + settingsPath(category.id) + '" data-action="settings-category" data-category="' + category.id + '" class="sub' + active + '">' +
        esc(category.label) + '</a>';
    }).join('') + '</div>';
  }

  // The Reports queues are listed under the Reports link while that section is open,
  // so the poll queue and the comment queue are each one click away.
  function renderReportsSubNav() {
    return '<div class="subnav">' + REPORT_SECTIONS.map(function (section) {
      var active = state.reportSection === section.id ? ' active' : '';
      return '<a href="' + reportSectionPath(section.id) + '" data-action="report-section" data-section="' + section.id + '" class="sub' + active + '">' +
        esc(section.label) + '</a>';
    }).join('') + '</div>';
  }

  function renderShell() {
    var items = ['overview', 'polls', 'topics', 'reports', 'comments', 'users', 'admins'];
    if (isSuperAdmin()) items.push('audit');
    items.push('settings');
    var nav = items.map(function (item) {
      var link = '<a href="' + pathForView(item) + '" data-action="tab" data-view="' + item + '" class="' + (state.view === item ? 'active' : '') + '">' +
        (NAV_ICONS[item] || '') +
        '<span>' + item.charAt(0).toUpperCase() + item.slice(1) + '</span></a>';
      if (item === 'settings' && state.view === 'settings') return link + renderSettingsSubNav();
      if (item === 'reports' && state.view === 'reports') return link + renderReportsSubNav();
      return link;
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

  // Loads the data for the active view; showView renders it.
  function loadCurrent() {
    if (state.view === 'overview') return loadOverview();
    if (state.view === 'polls') return loadPolls();
    if (state.view === 'topics') return loadTopics();
    if (state.view === 'reports') return loadReports();
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
    else if (state.view === 'topics') renderTopics();
    else if (state.view === 'reports') renderReports();
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
    if (action === 'settings-category') {
      event.preventDefault();
      navigateToSettingsCategory(target.getAttribute('data-category'));
      return;
    }
    if (action === 'report-section') {
      event.preventDefault();
      navigateToReportSection(target.getAttribute('data-section'));
      return;
    }
    if (action === 'refresh') {
      state.overview = null; state.polls = null;
      state.comments = null; state.admins = null; state.audit = null; state.settings = null;
      state.reports = null;
      state.topics = null;
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
    if (handleReportsAction(action, target)) return;
    if (handlePollsAction(action, target)) return;
    if (handleTopicsAction(action, target)) return;
    if (handleSettingsAction(action, target)) return;
    if (handleCommentsAction(action, target)) return;
    if (handleUsersAction(action, target)) return;
    if (handleAdminsAction(action, target)) return;
    if (handleAuditAction(action, target)) return;
  });

  app.addEventListener('change', function (event) {
    var target = event.target;
    if (!target || !target.getAttribute) return;
    var action = target.getAttribute('data-action');
    if (action === 'poll-status' || action === 'poll-topic') {
      handlePollsChange(target);
    }
  });

  function boot() {
    api('/api/admin/session').then(function (result) {
      state.session = result;
      state.turnstile = result.turnstile || { enabled: false, siteKey: '' };
      state.publicSiteOrigin = result.publicSiteOrigin || '';
      state.user = result.user || null;

      if (result.setupRequired) {
        renderSetup();
        return;
      }
      if (!result.authenticated) {
        renderLogin();
        return;
      }

      applyLocation(window.location.pathname);
      // Normalize aliases and disallowed paths (for example "/index.html" or
      // "/audit" for a regular admin) to the canonical URL for the resolved view.
      window.history.replaceState({}, '', pathForView(state.view));
      state.overview = null; state.polls = null;
      state.comments = null; state.admins = null; state.audit = null; state.settings = null;
      state.reports = null;
      state.topics = null;
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
    applyLocation(window.location.pathname);
    showResolvedView();
  });

  boot();`;
