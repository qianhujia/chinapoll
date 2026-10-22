// Settings page: edit and initialize application settings with categorized tabs.

export const scriptSettings = `  var CATEGORY_ORDER = ['general', 'appearance', 'polls', 'auth', 'reports', 'ai', 'publishing', 'advanced'];

  function settingRow(item) {
    var type = item.isSecret ? 'password' : (item.type === 'boolean' ? 'checkbox' : (item.type === 'enum' ? 'select' : (item.type === 'image_base64' ? 'file' : 'text')));
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
    } else if (item.type === 'image_base64') {
      var previewHtml = value ? '<img src="' + esc(value) + '" alt="preview" style="max-height:60px;margin-top:4px">' : '';
      var fileInputId = 'setting-' + esc(item.key) + '-file';
      var hiddenInputId = 'setting-' + esc(item.key);
      inputHtml = '<div class="file-upload">' +
        '<input type="file" id="' + fileInputId + '" data-key="' + esc(item.key) + '" accept="image/png,image/jpeg,image/svg+xml,image/webp,image/x-icon">' +
        '<input type="hidden" id="' + hiddenInputId + '" data-key="' + esc(item.key) + '" value="' + esc(value) + '">' +
        '<div class="file-preview" data-key="' + esc(item.key) + '">' + previewHtml + '</div>' +
        (value ? '<button type="button" class="secondary" data-action="clear-image" data-key="' + esc(item.key) + '">Remove</button>' : '') +
        '</div>';
    } else {
      inputHtml = '<input id="setting-' + esc(item.key) + '" type="' + type + '" data-key="' + esc(item.key) + '" value="' + esc(value) + '" placeholder="' + esc(placeholder) + '"' + (item.min !== undefined ? ' min="' + item.min + '"' : '') + (item.max !== undefined ? ' max="' + item.max + '"' : '') + '>';
    }

    var metaParts = [];
    if (item.isSecret) metaParts.push('secret');
    metaParts.push('default: ' + esc(item.defaultValue));
    if (item.min !== undefined && item.max !== undefined) metaParts.push('range: ' + item.min + '–' + item.max);

    return '<div class="setting-row" data-key="' + esc(item.key) + '">' +
      '<div><label for="setting-' + esc(item.key) + '-file">' + esc(item.label) + '</label>' +
      '<div class="meta">' + metaParts.join(' · ') + '</div>' +
      (item.description ? '<div class="small muted desc">' + esc(item.description) + '</div>' : '') +
      '</div>' +
      '<div>' + inputHtml + '</div>' +
      '<div class="setting-status" data-status-key="' + esc(item.key) + '">' + (item.isSet ? ('last updated ' + esc(formatDate(item.updatedAt))) : '') + '</div>' +
      '</div>';
  }

  function renderCategoryTab(category) {
    var settings = state.settings.categories.find(function (c) { return c.category === category; });
    if (!settings || settings.settings.length === 0) return '';
    var rows = settings.settings.map(settingRow).join('');
    var isActive = state.settings.activeTab === category ? ' active' : '';
    return '<div class="tab-panel' + isActive + '" data-tab="' + esc(category) + '">' +
      '<div class="setting-list">' + rows + '</div>' +
      '<div class="toolbar"><button class="primary" data-action="save-settings-category" data-category="' + esc(category) + '">Save ' + esc(settings.label) + '</button></div>' +
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
      '<section class="card mt-18"><h2>Poll topics</h2>' +
      '<p class="small muted">Topics order the public home page chip row and the submit form dropdown. Add and edit them in the Topics tab, or start from the suggested set.</p>' +
      '<div class="toolbar"><button data-action="insert-suggested-topics">Insert suggested topics</button></div>' +
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
    if (action === 'save-settings-category') {
      var category = target.getAttribute('data-category');
      return saveCategory(category, target);
    }
    if (action === 'save-setting') {
      var key = target.getAttribute('data-key');
      return saveSingleSetting(key, target);
    }
    if (action === 'clear-image') {
      var key = target.getAttribute('data-key');
      return clearImage(key, target);
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
    if (action === 'insert-suggested-topics') {
      if (!window.confirm('Insert the suggested topics (politics, economy, education, environment, health, technology, culture, society, other)?')) return true;
      target.disabled = true;
      guard(api('/api/admin/topics/suggested', { method: 'POST' }).then(function (result) {
        toast(result.message);
        state.topics = null;
      }).then(function () { target.disabled = false; }));
      return true;
    }
    return false;
  }

  function saveCategory(category, button) {
    var panel = document.querySelector('.tab-panel[data-tab="' + esc(category) + '"]');
    if (!panel) return true;

    // Get all inputs except file inputs (hidden inputs for images store the base64)
    var inputs = panel.querySelectorAll('[data-key]:not([type="file"])');
    var updates = {};
    inputs.forEach(function (input) {
      var key = input.getAttribute('data-key');
      if (!key) return;
      var value;
      if (input.type === 'checkbox') {
        value = input.checked ? 'true' : 'false';
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
      // Handled by base64 conversion on change
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

  function clearImage(key, button) {
    if (!window.confirm('Remove this image?')) return true;
    button.disabled = true;
    guard(api('/api/admin/settings/' + encodeURIComponent(key), {
      method: 'PUT',
      body: JSON.stringify({ value: '' })
    }).then(function (result) {
      toast(result.message);
      return loadSettings();
    }).then(function () { button.disabled = false; }));
    return true;
  }

  // Handle file input for base64 image conversion
  app.addEventListener('change', function (event) {
    var input = event.target;
    if (!input.matches('input[type="file"][data-key]')) return;
    var key = input.getAttribute('data-key');
    var file = input.files[0];
    if (!file) return;

    var allowedTypes = ['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp', 'image/x-icon'];
    if (!allowedTypes.includes(file.type)) {
      toast('File type not allowed. Use PNG, JPEG, SVG, WebP, or ICO.', true);
      input.value = '';
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast('File too large. Maximum size is 5MB.', true);
      input.value = '';
      return;
    }

    var reader = new FileReader();
    reader.onload = function (e) {
      var base64 = e.target.result;
      // Store the base64 in the hidden input for the save
      var hiddenInput = document.getElementById('setting-' + key);
      if (!hiddenInput) {
        hiddenInput = document.createElement('input');
        hiddenInput.type = 'hidden';
        hiddenInput.id = 'setting-' + key;
        hiddenInput.setAttribute('data-key', key);
        input.parentNode.appendChild(hiddenInput);
      }
      hiddenInput.value = base64;

      // Update preview
      var preview = document.querySelector('.file-preview[data-key="' + esc(key) + '"]');
      if (preview) preview.innerHTML = '<img src="' + esc(base64) + '" alt="preview" class="image-preview">';

      // Show remove button
      var removeBtn = input.parentNode.querySelector('[data-action="clear-image"]');
      if (!removeBtn) {
        removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'secondary';
        removeBtn.setAttribute('data-action', 'clear-image');
        removeBtn.setAttribute('data-key', key);
        removeBtn.textContent = 'Remove';
        input.parentNode.appendChild(removeBtn);
      }

      toast('Image loaded. Click Save to store.');
    };
    reader.readAsDataURL(file);
  });`;