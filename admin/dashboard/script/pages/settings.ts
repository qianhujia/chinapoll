// Settings page: edit and initialize application settings.

export const scriptSettings = `  // Keys that belong to the "Public audit repository" card. They are rendered
  // separately from the generic settings list so the card can offer its own
  // Test connection and Publish now buttons.
  var PUBLISH_KEYS = ['publish_enable', 'publish_repository', 'publish_branch', 'publish_path', 'github_token'];

  function settingRow(item) {
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
  }

  function renderSettings() {
    var view = document.getElementById('view');
    var data = state.settings;
    if (!data) {
      view.innerHTML = '<section class="card"><h2>Settings</h2><div class="empty">Loading…</div></section>';
      return;
    }

    var genericRows = data.settings.filter(function (item) {
      return PUBLISH_KEYS.indexOf(item.key) === -1;
    }).map(settingRow).join('');

    var publishRows = data.settings.filter(function (item) {
      return PUBLISH_KEYS.indexOf(item.key) !== -1;
    }).map(settingRow).join('');

    view.innerHTML = 
      '<section class="card"><h2>Public audit repository</h2>' +
      '<p class="small muted">When publishing is on, the hourly maintenance run copies the signed snapshot chain to a GitHub repository in one commit per hour. The token is stored as a secret and is never returned or logged.</p>' +
      '<div class="toolbar">' +
      '<button data-action="publish-test">Test connection</button>' +
      '<button class="primary" data-action="publish-run">Publish now</button>' +
      '</div>' +
      publishRows + '</section>' +
      '<section class="card" style="margin-top:18px"><h2>Application settings</h2>' +
      '<p class="small muted">Values are validated with the same rules the public Worker API enforces.</p>' +
      '<div class="toolbar"><button data-action="initialize-settings">Insert missing defaults</button></div>' +
      genericRows + '</section>';
  }

  function loadSettings() {
    return api('/api/admin/settings').then(function (data) {
      state.settings = data;
      if (state.view === 'settings') renderSettings();
    });
  }

  function handleSettingsAction(action, target) {
    if (action === 'save-setting') {
      var key = target.getAttribute('data-key');
      var input = document.getElementById('setting-' + key);
      var value = input.value;
      if (input.type === 'password' && value === '') {
        toast('Enter a new secret value or leave it unchanged.', true);
        return true;
      }
      target.disabled = true;
      guard(api('/api/admin/settings/' + encodeURIComponent(key), {
        method: 'PUT',
        body: JSON.stringify({ value: value })
      }).then(function (result) {
        toast(result.message);
        return loadSettings();
      }).then(function () { target.disabled = false; }));
      return true;
    }
    if (action === 'initialize-settings') {
      target.disabled = true;
      guard(api('/api/admin/settings/initialize', { method: 'POST' }).then(function (result) {
        toast(result.message);
        return loadSettings();
      }));
      return true;
    }
    if (action === 'publish-test') {
      target.disabled = true;
      guard(api('/api/admin/settings/publish/test', { method: 'POST' }).then(function (result) {
        toast(result.message);
      }).then(function () { target.disabled = false; }));
      return true;
    }
    if (action === 'publish-run') {
      target.disabled = true;
      guard(api('/api/admin/settings/publish/run', { method: 'POST' }).then(function (result) {
        toast(result.message);
        return loadOverview();
      }).then(function () { target.disabled = false; }));
      return true;
    }
    return false;
  }`;
