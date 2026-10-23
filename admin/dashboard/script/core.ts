// Shared client state, helpers, and the URL-aware view router.

export const scriptCore = `  var app = document.getElementById('app');

  // The Settings view is split into one page per category, each with its own URL
  // (\"/settings/<id>\"). The ids, labels, and icons mirror SETTING_CATEGORIES in
  // shared/settings.ts; the settings API repeats the labels for the page headings.
  var SETTINGS_CATEGORIES = [
    { id: 'general', label: 'General', icon: '🏠' },
    { id: 'appearance', label: 'Appearance', icon: '🎨' },
    { id: 'polls', label: 'Polls & Voting', icon: '📊' },
    { id: 'auth', label: 'Authentication', icon: '🔐' },
    { id: 'reports', label: 'Reports & Moderation', icon: '🚩' },
    { id: 'ai', label: 'AI Features', icon: '🤖' },
    { id: 'publishing', label: 'Audit Publishing', icon: '📤' },
    { id: 'advanced', label: 'Advanced', icon: '⚙️' }
  ];
  var DEFAULT_SETTINGS_CATEGORY = SETTINGS_CATEGORIES[0].id;

  var state = {
    view: 'overview',
    user: null,
    session: null,
    turnstile: { enabled: false, siteKey: '' },
    turnstileWidgetId: undefined,
    publicSiteOrigin: '',
    overview: null,
    polls: null,
    reports: null,
    comments: null,
    users: null,
    admins: null,
    audit: null,
    settings: null,
    // The Settings category whose page is open (see SETTINGS_CATEGORIES).
    settingsCategory: DEFAULT_SETTINGS_CATEGORY,
    topics: null,
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
  // \"/categories\" is kept as a legacy alias so bookmarks created before the
  // topics rename still resolve; it normalizes to \"/topics\".
  var VIEW_PATHS = { overview: '/', polls: '/polls', topics: '/topics', reports: '/reports', comments: '/comments', users: '/users', admins: '/admins', audit: '/audit' };
  var PATH_VIEWS = { '/': 'overview', '/overview': 'overview', '/polls': 'polls', '/topics': 'topics', '/categories': 'topics', '/reports': 'reports', '/comments': 'comments', '/users': 'users', '/admins': 'admins', '/audit': 'audit' };

  function normalizePath(pathname) {
    var path = pathname || '/';
    while (path.length > 1 && path.charAt(path.length - 1) === '/') {
      path = path.slice(0, -1);
    }
    return path;
  }

  function isSettingsCategory(id) {
    return SETTINGS_CATEGORIES.some(function (category) { return category.id === id; });
  }

  function settingsPath(category) {
    return '/settings/' + category;
  }

  // The settings sub-page named by a path, or an empty string when the path is
  // not a settings page. \"/settings\" resolves to the default category.
  function settingsCategoryFromPath(pathname) {
    var path = normalizePath(pathname);
    if (path === '/settings') return DEFAULT_SETTINGS_CATEGORY;
    if (path.indexOf('/settings/') !== 0) return '';
    var id = path.slice('/settings/'.length);
    return isSettingsCategory(id) ? id : '';
  }

  function viewFromPath(pathname) {
    if (settingsCategoryFromPath(pathname)) return 'settings';
    return PATH_VIEWS[normalizePath(pathname)] || 'overview';
  }

  function pathForView(view) {
    if (view === 'settings') return settingsPath(state.settingsCategory || DEFAULT_SETTINGS_CATEGORY);
    return VIEW_PATHS[view] || '/';
  }

  // Resolves a URL into the active view and the open settings sub-page. An unknown
  // settings category keeps the default page so the address bar and the rendered
  // page never disagree.
  function applyLocation(pathname) {
    state.view = allowedView(viewFromPath(pathname));
    state.settingsCategory = settingsCategoryFromPath(pathname) || DEFAULT_SETTINGS_CATEGORY;
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

  // Opens one Settings page. Every category is its own URL so it can be linked,
  // bookmarked, and reloaded like every other view.
  function navigateToSettingsCategory(category) {
    if (!isSettingsCategory(category)) {
      navigateToView('settings');
      return;
    }
    state.view = 'settings';
    state.settingsCategory = category;
    var path = settingsPath(category);
    if (window.location.pathname !== path) {
      window.history.pushState({ view: 'settings', category: category }, '', path);
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
