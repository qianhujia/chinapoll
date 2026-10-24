// Overview page: statistics and latest submissions.

export const scriptOverview = `  function statCard(value, label) {
    return '<div class="card stat"><div class="value">' + esc(value) + '</div><div class="label">' + esc(label) + '</div></div>';
  }

  function renderOverview() {
    var view = document.getElementById('view');
    if (!state.overview) {
      view.innerHTML = '<div class="empty">Loading…</div>';
      return;
    }
    var o = state.overview;
    var recent = o.recentPending.length
      ? '<table><thead><tr><th>ID</th><th>Title</th><th>Mode</th><th>Submitted</th></tr></thead><tbody>' +
        o.recentPending.map(function (row) {
          return '<tr><td>' + esc(row.id) + '</td><td>' + esc(row.title || '(no title)') + '</td>' +
            '<td>' + esc(row.mode === 1 ? 'deadline' : 'evergreen') + '</td>' +
            '<td class="small">' + esc(formatDate(row.createdAt)) + '</td></tr>';
        }).join('') + '</tbody></table>'
      : '<div class="empty">No pending submissions.</div>';

    view.innerHTML =
      '<section class="grid">' +
      statCard(o.pending, 'Pending submissions') +
      statCard(o.open, 'Open polls') +
      statCard(o.closed, 'Closed polls') +
      statCard(o.archived, 'Archived polls') +
      statCard(o.votes, 'Total votes') +
      statCard(o.views24h, 'Views (24h)') +
      statCard(o.views7d, 'Views (7d)') +
      statCard(o.comments, 'Total comments') +
      reportsCard(o.openReports + o.openCommentReports) +
      statCard(o.users, 'Public users') +
      statCard(o.adminUsers, 'Admin users') +
      (isSuperAdmin() ? statCard(o.auditEntries, 'Audit entries') : '') +
      statCard(o.settings, 'Settings rows') +
      '</section>' +
      '<section class="card mt-18"><h2>Latest submissions</h2>' + recent + '</section>' +
      '<section class="card mt-18"><h2>Audit publishing</h2>' + publishSection(o) + '</section>';
  }

  // Publish status plus the last five runs. The heading is highlighted when the
  // most recent run failed; the timestamp is the last completed run.
  function publishSection(o) {
    var status = o.publishError
      ? '<p class="text-err">The most recent publish run failed.</p>'
      : '<p class="small muted">Last publish: ' + esc(formatDate(o.lastPublishAt)) + '</p>';
    var runs = o.publishRuns && o.publishRuns.length
      ? '<table><thead><tr><th>Started</th><th>Finished</th><th>Polls</th><th>Result</th></tr></thead><tbody>' +
        o.publishRuns.map(function (run) {
          return '<tr><td class="small">' + esc(formatDate(run.startedAt)) + '</td>' +
            '<td class="small">' + esc(formatDate(run.finishedAt)) + '</td>' +
            '<td>' + esc(run.pollsUpdated) + '</td>' +
            '<td class="small' + (run.error ? ' text-err' : '') + '">' +
            esc(run.error ? 'failed: ' + run.error : 'ok') + '</td></tr>';
        }).join('') + '</tbody></table>'
      : '<div class="empty">No publish runs recorded.</div>';
    return status + runs;
  }

  // Open-report count card. It links to the Reports tab and is highlighted when
  // there is anything waiting for moderation.
  function reportsCard(count) {
    var cls = 'card stat card-link' + (count > 0 ? ' alert' : '');
    return '<a class="' + cls + '" href="/reports" data-action="tab" data-view="reports">' +
      '<div class="value">' + esc(count) + '</div><div class="label">Open reports</div></a>';
  }

  function loadOverview() {
    return api('/api/admin/overview').then(function (data) {
      state.overview = data.overview;
      if (state.view === 'overview') renderOverview();
    });
  }
`;
