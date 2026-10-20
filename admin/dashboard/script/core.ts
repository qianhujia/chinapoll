// Shared client state, helpers, and the URL-aware view router.

export const scriptCore = `  var app = document.getElementById('app');
  var state = {
    view: 'overview',
    user: null,
    session: null,
    turnstile: { enabled: false, siteKey: '' },
    publicSiteOrigin: '',
    overview: null,
    polls: null,
    reports: null,
    comments: null,
    users: null,
    admins: null,
    audit: null,
    settings: null,
    categories: null,
    pollStatus: 'all',
    pollQuery: '',
    // Poll ids whose option editor is expanded in the Polls tab.
    expandedPolls: [],
    reportStatus: 'open',
    commentQuery: '',
    commentPollId: '',
    userStatus: 'all',
    userQuery: '',
    auditAction: '',
    auditQuery: '',
    pollPage: 1,
    reportPage: 1,
    commentPage: 1,
    userPage: 1,
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

  // Each dashboard view has a dedicated URL. The overview is also reachable at
  // "/overview" as an alias of "/".
  var VIEW_PATHS = { overview: '/', polls: '/polls', categories: '/categories', reports: '/reports', comments: '/comments', users: '/users', admins: '/admins', audit: '/audit', settings: '/settings' };
  var PATH_VIEWS = { '/': 'overview', '/overview': 'overview', '/polls': 'polls', '/categories': 'categories', '/reports': 'reports', '/comments': 'comments', '/users': 'users', '/admins': 'admins', '/audit': 'audit', '/settings': 'settings' };

  function viewFromPath(pathname) {
    var path = pathname || '/';
    while (path.length > 1 && path.charAt(path.length - 1) === '/') {
      path = path.slice(0, -1);
    }
    return PATH_VIEWS[path] || 'overview';
  }

  function pathForView(view) {
    return VIEW_PATHS[view] || '/';
  }

  // The audit view is super-admin only; disallowed or unknown views fall back to
  // the overview.
  function allowedView(view) {
    if (view === 'audit' && !isSuperAdmin()) return 'overview';
    return view;
  }

  function showResolvedView() {
    renderShell();
    showView();
    guard(loadCurrent());
  }

  // Switches views and keeps the address bar in sync with a real URL.
  function navigateToView(view) {
    state.view = allowedView(view);
    var path = pathForView(state.view);
    if (window.location.pathname !== path) {
      window.history.pushState({ view: state.view }, '', path);
    }
    showResolvedView();
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

  function guard(promise) {
    return promise.catch(function (error) {
      if (error && error.status === 401) {
        renderLogin('Your session expired. Please sign in again.');
        return;
      }
      toast(error && error.message ? error.message : 'Request failed.', true);
    });
  }
`;
