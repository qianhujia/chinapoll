// Login and first-run setup screens.

export const scriptAuth = `  function waitForTurnstile(callback) {
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
        var widgetId = turnstile.render(slot, {
          sitekey: siteKey,
          callback: onToken,
          'error-callback': function () { onToken(''); },
          'expired-callback': function () { onToken(''); }
        });
        state.turnstileWidgetId = widgetId;
      } catch (error) {
        // The widget fails closed; the server still requires a valid token.
      }
    });
  }

  function resetTurnstileWidget() {
    var turnstile = state.turnstile || { enabled: false, siteKey: '' };
    if (!turnstile.enabled) return;
    waitForTurnstile(function (turnstile) {
      var widgetId = state.turnstileWidgetId;
      if (widgetId !== undefined) {
        turnstile.reset(widgetId);
      }
    });
  }

  function renderLogin(message) {
    var turnstile = state.turnstile || { enabled: false, siteKey: '' };
    var turnstileField = turnstile.enabled ? '<div class="turnstile" id="turnstile-slot"></div>' : '';
    app.innerHTML = '<form class="login" id="login-form">' +
      '<h1>ChinaPoll <span class="accent">Admin</span></h1>' +
      '<p>Sign in with your admin username and password.</p>' +
      '<label for="login-username">Username</label>' +
      '<input id="login-username" autocomplete="username" autofocus>' +
      '<label for="login-password" class="mt-12">Password</label>' +
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
        .catch(function (error) {
          errorBox.textContent = error.message;
          resetTurnstileWidget();
          turnstileToken = '';
        });
    });
  }

  function renderSetup(message) {
    app.innerHTML = '<form class="login" id="setup-form">' +
      '<h1>Create first admin</h1>' +
      '<p>No admin users exist yet. Create the first account; it becomes the super admin.</p>' +
      '<label for="setup-username">Username</label>' +
      '<input id="setup-username" autocomplete="username" autofocus>' +
      '<label for="setup-password" class="mt-12">Password (min 12 characters)</label>' +
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
`;
