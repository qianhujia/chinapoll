// Assembles the browser client script from per-page fragments.
//
// The admin dashboard is served as one inline <script> (see renderDashboard), so
// each fragment is a string of JavaScript that is concatenated into a single
// IIFE. `core` must come first because it declares the shared state and helpers,
// and `shell` must come last because it registers the event listeners and boots
// the application. The page fragments only declare functions, so their relative
// order does not matter.

import { scriptCore } from './core';
import { scriptAuth } from './auth';
import { scriptOverview } from './pages/overview';
import { scriptPolls } from './pages/polls';
import { scriptTopics } from './pages/topics';
import { scriptReports } from './pages/reports';
import { scriptComments } from './pages/comments';
import { scriptUsers } from './pages/users';
import { scriptAdmins } from './pages/admins';
import { scriptAudit } from './pages/audit';
import { scriptSettings } from './pages/settings';
import { scriptShell } from './shell';

export const dashboardScript = [
  scriptCore,
  scriptAuth,
  scriptOverview,
  scriptPolls,
  scriptTopics,
  scriptReports,
  scriptComments,
  scriptUsers,
  scriptAdmins,
  scriptAudit,
  scriptSettings,
  scriptShell
].join('\n');
