// Settings pages: one page per settings category.
//
// Every category has its own URL ("/settings/<category>") and its own sidebar
// sub-item (see core.ts and shell.ts), so this fragment renders exactly one
// category per page and reloads that page after a save.

export const scriptSettings = `  var SETTINGS_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp', 'image/x-icon', 'image/vnd.microsoft.icon'];
  var SETTINGS_IMAGE_ACCEPT = SETTINGS_IMAGE_TYPES.join(',');
  // An uploaded image is stored in the settings table as a base64 data URI, and a
  // D1 row is capped at 2 MB, so a file is limited to 700 KB (about 950 KB once
  // encoded). A pasted https URL is stored as it is.
  var SETTINGS_IMAGE_MAX_BYTES = 700 * 1024;

  // The extension an uploaded image's public URL uses, mirroring IMAGE_EXTENSIONS in
  // shared/settings.ts so the URL shown here is the one the site serves.
  var SETTINGS_IMAGE_EXTENSIONS = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/svg+xml': 'svg',
    'image/webp': 'webp',
    'image/x-icon': 'ico',
    'image/vnd.microsoft.icon': 'ico',
    'image/ico': 'ico'
  };

  function imageExtension(value) {
    var separator = value.indexOf(';');
    var type = separator > 5 ? value.slice(5, separator).toLowerCase() : '';
    return SETTINGS_IMAGE_EXTENSIONS[type] || 'img';
  }

  // The public URL of a saved image: an uploaded image is served by the site as
  // /image/<key>.<extension>, a pasted URL is used as-is. The version query matches
  // the one the public site uses, so a copied link fetches the current image.
  function imagePublicUrl(item) {
    var value = item.value || '';
    if (!value) return '';
    if (value.indexOf('data:') !== 0) return value;
    var version = '';
    if (item.updatedAt) {
      var seconds = Math.floor(new Date(item.updatedAt).getTime() / 1000);
      if (!isNaN(seconds)) version = '?v=' + seconds;
    }
    return (state.publicSiteOrigin || '') + '/image/' + item.key + '.' + imageExtension(value) + version;
  }

  function imageUrlLine(url, source) {
    if (!url) return '<span class="small muted">No image set.</span>';
    return '<span class="small muted">URL:</span> ' +
      '<a class="small" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(url) + '</a>' +
      (source ? ' <span class="small muted">(' + esc(source) + ')</span>' : '');
  }

  function imageUrlMarkup(item) {
    var value = item.value || '';
    if (!value) return imageUrlLine('', '');
    return imageUrlLine(imagePublicUrl(item), value.indexOf('data:') === 0 ? 'uploaded' : 'external URL');
  }

  // Reflects an edit in the row before it is saved: the hidden input holds the
  // value that gets saved, and the preview and the URL line follow it. For an
  // upload the URL line can only show the final versioned URL after saving.
  function applyImageEdit(key, value) {
    var hidden = document.getElementById('setting-' + key);
    if (hidden) hidden.value = value;

    var preview = document.querySelector('.file-preview[data-key="' + esc(key) + '"]');
    if (preview) {
      preview.innerHTML = value ? '<img src="' + esc(value) + '" alt="preview" class="image-preview">' : '';
    }

    var display = document.querySelector('[data-image-url-display="' + esc(key) + '"]');
    if (!display) return;
    if (!value) {
      display.innerHTML = imageUrlLine('', '');
      return;
    }
    var uploaded = value.indexOf('data:') === 0;
    display.innerHTML = imageUrlLine(
      uploaded ? (state.publicSiteOrigin || '') + '/image/' + key + '.' + imageExtension(value) : value,
      uploaded ? 'uploaded' : 'external URL'
    );
  }

  function settingRow(item) {
    var type = item.isSecret ? 'password' : (item.type === 'boolean' ? 'checkbox' : (item.type === 'enum' ? 'select' : (item.type === 'image' ? 'file' : 'text')));
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
    } else if (item.type === 'image') {
      var previewHtml = value ? '<img src="' + esc(value) + '" alt="preview" class="image-preview">' : '';
      var fileInputId = 'setting-' + esc(item.key) + '-file';
      var hiddenInputId = 'setting-' + esc(item.key);
      var urlInputId = 'setting-' + esc(item.key) + '-url';
      // A saved pasted URL seeds the URL field; an uploaded image is shown in the
      // preview and served by the branding endpoint once it is saved.
      var pastedUrl = value && value.indexOf('data:') !== 0 ? value : '';
      inputHtml = '<div class="file-upload">' +
        '<input type="file" id="' + fileInputId + '" data-key="' + esc(item.key) + '" accept="' + SETTINGS_IMAGE_ACCEPT + '">' +
        '<input type="hidden" id="' + hiddenInputId + '" data-key="' + esc(item.key) + '" value="' + esc(value) + '">' +
        '<div class="file-preview" data-key="' + esc(item.key) + '">' + previewHtml + '</div>' +
        (value ? '<button type="button" class="secondary" data-action="clear-image" data-key="' + esc(item.key) + '">Remove</button>' : '') +
        '<div class="image-url" data-image-url-display="' + esc(item.key) + '">' + imageUrlMarkup(item) + '</div>' +
        '<label class="small muted" for="' + urlInputId + '">Or paste an image URL</label>' +
        '<input type="url" id="' + urlInputId + '" data-image-url-for="' + esc(item.key) + '" value="' + esc(pastedUrl) + '" placeholder="https://example.com/logo.png">' +
        '</div>';
    } else if (item.type === 'text') {
      // A multi-line setting (for example the AI review prompt) keeps its line
      // breaks, so it is edited in a textarea instead of a single-line input.
      inputHtml = '<textarea id="setting-' + esc(item.key) + '" data-key="' + esc(item.key) + '" rows="6" placeholder="' + esc(placeholder) + '"' + (item.max !== undefined ? ' maxlength="' + item.max + '"' : '') + '>' + esc(value) + '</textarea>';
    } else {
      inputHtml = '<input id="setting-' + esc(item.key) + '" type="' + type + '" data-key="' + esc(item.key) + '" value="' + esc(value) + '" placeholder="' + esc(placeholder) + '"' + (item.min !== undefined ? ' min="' + item.min + '"' : '') + (item.max !== undefined ? ' max="' + item.max + '"' : '') + '>';
    }

    var metaParts = [];
    if (item.isSecret) metaParts.push('secret');
    metaParts.push('default: ' + esc(item.defaultValue));
    if (item.min !== undefined && item.max !== undefined) metaParts.push('range: ' + item.min + '–' + item.max);

    // The label points at the file picker for images and at the control itself
    // otherwise, so clicking it always focuses what it names.
    var labelTarget = item.type === 'image'
      ? 'setting-' + esc(item.key) + '-file'
      : 'setting-' + esc(item.key);

    return '<div class="setting-row" data-key="' + esc(item.key) + '">' +
      '<div><label for="' + labelTarget + '">' + esc(item.label) + '</label>' +
      '<div class="meta">' + metaParts.join(' · ') + '</div>' +
      (item.description ? '<div class="small muted desc">' + esc(item.description) + '</div>' : '') +
      '</div>' +
      '<div>' + inputHtml + '</div>' +
      '<div class="setting-status" data-status-key="' + esc(item.key) + '">' + (item.isSet ? ('last updated ' + esc(formatDate(item.updatedAt))) : '') + '</div>' +
      '</div>';
  }

  function renderSettings() {
    var view = document.getElementById('view');
    var data = state.settings;
    if (!data) {
      view.innerHTML = '<section class="card"><h2>Settings</h2><div class="empty">Loading…</div></section>';
      return;
    }

    var category = state.settingsCategory || DEFAULT_SETTINGS_CATEGORY;
    var catData = data.categories.find(function (c) { return c.category === category; });
    if (!catData) {
      view.innerHTML = '<section class="card"><h2>Settings</h2><div class="empty">Unknown settings category.</div></section>';
      return;
    }

    var rows = catData.settings.length
      ? '<div class="setting-list">' + catData.settings.map(settingRow).join('') + '</div>'
      : '<div class="empty">No settings in this category.</div>';

    var html = '<section class="card">' +
      '<h2>' + esc(catData.label) + '</h2>' +
      (catData.description ? '<p class="small muted">' + esc(catData.description) + '</p>' : '') +
      '<p class="small muted">Values are validated with the same rules the public Worker API enforces. A blank field keeps its default and is not stored.</p>' +
      rows +
      '<div class="toolbar mt-12"><button class="primary" data-action="save-settings-category" data-category="' + esc(category) + '">Save ' + esc(catData.label) + '</button></div>' +
      '</section>';

    // The publish actions belong to the audit publishing settings, so they live on
    // that page rather than in a section of their own.
    if (category === 'publishing') {
      html += '<section class="card mt-18"><h2>Publish now</h2>' +
        '<p class="small muted">The hourly maintenance run copies the signed snapshot chain to the configured GitHub repository, one commit per hour. The token is stored as a secret and is never returned or logged.</p>' +
        '<div class="toolbar">' +
        '<button data-action="publish-test">Test connection</button>' +
        '<button class="primary" data-action="publish-run">Publish now</button>' +
        '</div></section>';
    }

    view.innerHTML = html;
  }

  function loadSettings() {
    return api('/api/admin/settings').then(function (data) {
      state.settings = data;
      if (state.view === 'settings') renderSettings();
    });
  }

  function handleSettingsAction(action, target) {
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
    return false;
  }

  function saveCategory(category, button) {
    var view = document.getElementById('view');
    if (!view) return true;

    // Only form controls are collected. The image preview container and the
    // Remove button carry a data-key too, and reading a value from them would
    // drop the base64 held by the hidden input next to the file picker.
    var inputs = view.querySelectorAll('input[data-key]:not([type="file"]), select[data-key], textarea[data-key]');
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

    if (SETTINGS_IMAGE_TYPES.indexOf(file.type) === -1) {
      toast('File type not allowed. Use PNG, JPEG, SVG, WebP, or ICO.', true);
      input.value = '';
      return;
    }
    if (file.size > SETTINGS_IMAGE_MAX_BYTES) {
      toast('File too large. Maximum size is 700 KB.', true);
      input.value = '';
      return;
    }

    var reader = new FileReader();
    reader.onload = function (e) {
      var base64 = e.target.result;
      // An upload replaces a pasted URL: the URL field is cleared and the hidden
      // input, which is the value that gets saved, holds the data URI.
      var urlInput = input.parentNode.querySelector('[data-image-url-for]');
      if (urlInput) urlInput.value = '';
      applyImageEdit(key, base64);

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
  });

  // A pasted image URL is written straight into the hidden input, so one save
  // action stores either an uploaded image or a URL. Clearing the field removes
  // the image. The value is validated by the API, which reports it in a toast.
  app.addEventListener('input', function (event) {
    var input = event.target;
    if (!input || !input.getAttribute || !input.getAttribute('data-image-url-for')) return;
    applyImageEdit(input.getAttribute('data-image-url-for'), input.value.trim());
  });`;