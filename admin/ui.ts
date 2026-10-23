// Self-contained admin dashboard served by the admin Worker at "/" and at each
// dashboard view URL.
//
// The markup, styles, and client script are embedded so the Worker has no build
// step and no runtime dependencies. Styles live in ./dashboard/styles and the
// client script is assembled from the per-page fragments in ./dashboard/script.
// The client script uses string concatenation rather than template literals to
// avoid clashing with these server-side template strings.

import { dashboardStyles } from './dashboard/styles';
import { dashboardNavIconsScript } from './dashboard/icons';
import { dashboardScript } from './dashboard/script';

export function renderDashboard(nonce: string, turnstileEnabled = false): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>ChinaPoll Admin</title>
<style nonce="${nonce}">
${dashboardStyles}
</style>
${turnstileEnabled ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" async defer></script>' : ''}
</head>
<body>
<div id="app"></div>
<div id="toast-copy"></div>
<script nonce="${nonce}">
(function () {
  'use strict';
${dashboardNavIconsScript}${dashboardScript}
})();
</script>
</body>
</html>`;
}
