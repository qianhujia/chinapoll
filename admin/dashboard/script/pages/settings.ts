// Settings page: edit and initialize application settings with categorized tabs.

export const scriptSettings = `  var CATEGORY_ORDER = ['general', 'appearance', 'polls', 'auth', 'reports', 'ai', 'publishing', 'advanced'];

  function settingRow(item) {
    var type = item.isSecret ? 'password' : (item.type === 'boolean' ? 'checkbox' : (item.type === 'enum' ? 'select' : (item.isR2Upload ? 'file' : 'text')));
    var value = item.isSecret ? '' : (item.value === null ? '' : item.value);
    var placeholder = item.isSecret ? 'Leave blank to keep the current secret' : 'Not set';
    var enumOptions = item.enumOptions ? item.enumOptions.map(function (o) {
      return '<option value="' + esc(o.value) + '"' + (value === o.value ? ' selected' : '') + '>' + esc(o.label) + '</option>';
    }).join('') : '';

    var inputHtml;
    if (item.type === 'boolean') {
      inputHtml = '<label class="checkbox-label"><input type="checkbox" id="setting-' + esc(item.key) + '" data-key="' + esc(item.key) + '"' + (value === 'true' ? ' checked' : '') + '> ' + esc(item.label) + '</label>';
    } else if (item.type === 'enum') {
      inputHtml = '<select id="setting-' + esc(item.key) + '" data-key="' + esc(item.key) + '">' + enumOptions + '</select>';
    } else if (item.isR2Upload) {
      inputHtml = '<div class="file-upload"><input type="file" id="setting-' + esc(item.key) + '" data-key="' + esc(item.key) + '" accept="image/png,image/jpeg,image/svg+xml,image/webp,image/x-icon"><div class="file-preview" data-key="' + esc(item.key) + '"></div></div>';
    } else {
      inputHtml = '<input id="setting-' + esc(item.key) + '" type="' + type + '" data-key="' + esc(item.key) + '" value="' + esc(value) + '" placeholder="' + esc(placeholder) + '"' + (item.min !== undefined ? ' min="' + item.min + '"' : '') + (item.max !== undefined ? ' max="' + item.max + '"' : '') + '>';
    }

    var metaParts = [];
    if (item.isSecret) metaParts.push('secret');
    metaParts.push('default: ' + esc(item.defaultValue));
    if (item.min !== undefined && item.max !== undefined) metaParts.push('range: ' + item.min + '–' + item.max);

    return '<div class="setting-row" data-key="' + esc(item.key) + '">' +
      '<div><label for="setting-' + esc(item.key) + '">' + esc(item.label) + '</label>' +
      '<div class="meta">' + metaParts.join(' · ') + '</div>' +
      (item.description ? '<div class="small muted desc">' + esc(item.description) + '</div>' : '') +
      '</div>' +
      '<div>' + inputHtml + '</div>' +
      '<div class="setting-status" data-status-key="' + esc(item.key) + '">' + (item.isSet ? ('last updated ' + esc(formatDate(item.updatedAt))) : 'not set in database') + '</div>' +
      '</div>';
  }

  function renderCategoryTab(category) {
    var settings = state.settings.categories.find(function (c) { return c.category === category; });
    if (!settings || settings.settings.length === 0) return '';
    var rows = settings.settings.map(settingRow).join('');
    var isActive = state.settings.activeTab === category ? ' active' : '';
    return '<div class="tab-panel' + isActive + '" data-tab="' + esc(category) + '">' +
      '<div class="setting-list">' + rows + '</div>' +
      '<div class="toolbar"><button class="primary" data-action="save-category" data-category="' + esc(category) + '">Save ' + esc(settings.label) + '</button></div>' +
      '</div>';
  }

  function renderSettings() {
    var view = document.getElementById('view');
    var data = state.settings;
    if (!data) {
      view.innerHTML = '<section class="card"><h2>Settings</h2><div class="empty">Loading…</div></section>';
      return;
    }

    var tabs = CATEGORY_ORDER.map(function (cat) {
      var catData = data.categories.find(function (c) { return c.category === cat; });
      if (!catData || catData.settings.length === 0) return '';
      var isActive = data.activeTab === cat ? ' active' : '';
      return '<button class="tab' + isActive + '" data-action="switch-tab" data-tab="' + esc(cat) + '">' + esc(catData.icon + ' ' + catData.label) + '</button>';
    }).join('');

    var panels = CATEGORY_ORDER.map(renderCategoryTab).join('');

    view.innerHTML =
      '<section class="card">' +
        '<h2>Settings</h2>' +
        '<p class="small muted">Values are validated with the same rules the public Worker API enforces.</p>' +
        '<div class="tab-bar">' + tabs + '</div>' +
        panels +
      '</section>' +
      '<section class="card mt-18"><h2>Public audit repository</h2>' +
      '<p class="small muted">When publishing is on, the hourly maintenance run copies the signed snapshot chain to a GitHub repository in one commit per hour. The token is stored as a secret and is never returned or logged.</p>' +
      '<div class="toolbar">' +
      '<button data-action="publish-test">Test connection</button>' +
      '<button class="primary" data-action="publish-run">Publish now</button>' +
      '</div>' +
      renderPublishSection(data) +
      '</section>' +
      '<section class="card mt-18"><h2>Poll categories</h2>' +
      '<p class="small muted">Categories order the public home page chip row and the submit form dropdown. Add and edit them in the Categories tab, or start from the suggested set.</p>' +
      '<div class="toolbar"><button data-action="insert-suggested-categories">Insert suggested categories</button></div>' +
      '</section>';
  }

  function renderPublishSection(data) {
    var pubSettings = data.settings.filter(function (item) {
      return ['publish_enable', 'publish_repository', 'publish_branch', 'publish_path', 'github_token'].indexOf(item.key) !== -1;
    });
    return pubSettings.map(settingRow).join('');
  }

  function loadSettings() {
    return api('/api/admin/settings').then(function (data) {
      if (!data.activeTab) data.activeTab = 'general';
      state.settings = data;
      if (state.view === 'settings') renderSettings();
    });
  }

  function handleSettingsAction(action, target) {
    if (action === 'switch-tab') {
      var tab = target.getAttribute('data-tab');
      state.settings.activeTab = tab;
      renderSettings();
      return true;
    }
    if (action === 'save-category') {
      var category = target.getAttribute('data-category');
      return saveCategory(category, target);
    }
    if (action === 'save-setting') {
      var key = target.getAttribute('data-key');
      return saveSingleSetting(key, target);
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
    if (action === 'insert-suggested-categories') {
      if (!window.confirm('Insert the suggested categories (politics, economy, education, environment, health, technology, culture, society, other)?')) return true;
      target.disabled = true;
      guard(api('/api/admin/categories/suggested', { method: 'POST' }).then(function (result) {
        toast(result.message);
        state.categories = null;
      }).then(function () { target.disabled = false; }));
      return true;
    }
    return false;
  }

  function saveCategory(category, button) {
    var panel = document.querySelector('.tab-panel[data-tab="' + esc(category) + '"]');
    if (!panel) return true;

    var inputs = panel.querySelectorAll('[data-key]');
    var updates = {};
    inputs.forEach(function (input) {
      var key = input.getAttribute('data-key');
      if (!key) return;
      var value;
      if (input.type === 'checkbox') {
        value = input.checked ? 'true' : 'false';
      } else if (input.type === 'file') {
        // File uploads are handled separately via upload API
        return;
      } else {
        value = input.value;
      }
      updates[key] = value;
    });

    if (Object.keys(updates).length === 0) {
      toast('No changes to save.');
      return true;
    }

    button.disabled = true;
    guard(api('/api/admin/settings/bulk', {
      method: 'PUT',
      body: JSON.stringify(updates)
    }).then(function (result) {
      if (result.ok) {
        toast('Saved ' + category + ' settings.');
      } else {
        var errors = result.results.filter(function (r) { return !r.ok; }).map(function (r) { return r.key + ': ' + r.error; }).join('; ');
        toast('Some settings failed: ' + errors, true);
      }
      return loadSettings();
    }).then(function () { button.disabled = false; }));
    return true;
  }

  function saveSingleSetting(key, button) {
    var input = document.getElementById('setting-' + key);
    if (!input) return true;

    var value;
    if (input.type === 'checkbox') {
      value = input.checked ? 'true' : 'false';
    } else if (input.type === 'file') {
      // Handled by upload
      return true;
    } else {
      value = input.value;
    }

    if (input.type === 'password' && value === '') {
      toast('Enter a new secret value or leave it unchanged.', true);
      return true;
    }

    button.disabled = true;
    guard(api('/api/admin/settings/' + encodeURIComponent(key), {
      method: 'PUT',
      body: JSON.stringify({ value: value })
    }).then(function (result) {
      toast(result.message);
      return loadSettings();
    }).then(function () { button.disabled = false; }));
    return true;
  }

  // Handle file upload for R2 images
  app.addEventListener('change', function (event) {
    var input = event.target;
    if (!input.matches('input[type="file"][data-key]')) return;
    var key = input.getAttribute('data-key');
    var file = input.files[0];
    if (!file) return;

    var formData = new FormData();
    formData.append('file', file);
    formData.append('key', key);

    var preview = document.querySelector('.file-preview[data-key="' + esc(key) + '"]');
    if (preview) preview.textContent = 'Uploading...';

    api('/api/admin/settings/upload', {
      method: 'POST',
      body: formData
    }).then(function (result) {
      if (result.ok) {
        toast('Uploaded ' + file.name);
        if (preview) preview.innerHTML = '<img src="/assets/' + esc(result.assetKey) + '" alt="preview" style="max-height:60px">';
        return loadSettings();
      } else {
        toast(result.message, true);
        if (preview) preview.textContent = 'Upload failed';
      }
    }).catch(function () {
      toast('Upload failed', true);
      if (preview) preview.textContent = 'Upload failed';
    });
  });`;