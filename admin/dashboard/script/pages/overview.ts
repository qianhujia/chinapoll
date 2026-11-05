// Overview page: statistics and latest submissions.

export const scriptOverview = `  function statCard(value, label) {
    return '<div class="card stat"><div class="value">' + esc(value) + '</div><div class="label">' + esc(label) + '</div></div>';
  }

  // The overview's view chart: the daily view totals of every poll as one line, drawn
  // inline as SVG so the dashboard stays a single self-contained document with no chart
  // library and no third-party origin. The viewBox is fixed and the stylesheet scales
  // the SVG to its card, so the chart follows the window width without being redrawn.
  var VIEW_CHART_WIDTH = 640;
  var VIEW_CHART_HEIGHT = 180;
  var VIEW_CHART_PAD_X = 10;
  var VIEW_CHART_PAD_TOP = 14;
  var VIEW_CHART_PAD_BOTTOM = 22;

  function viewsChart(days) {
    var series = days || [];
    if (!series.length) return '<div class="empty">No views recorded yet.</div>';

    var peak = 0;
    series.forEach(function (entry) { if (entry.views > peak) peak = entry.views; });
    if (peak <= 0) {
      return '<div class="empty">No views recorded in the last ' + series.length + ' days.</div>';
    }

    var plotWidth = VIEW_CHART_WIDTH - VIEW_CHART_PAD_X * 2;
    var plotHeight = VIEW_CHART_HEIGHT - VIEW_CHART_PAD_TOP - VIEW_CHART_PAD_BOTTOM;
    var step = series.length > 1 ? plotWidth / (series.length - 1) : 0;
    var baseline = VIEW_CHART_HEIGHT - VIEW_CHART_PAD_BOTTOM;
    var points = series.map(function (entry, index) {
      return {
        x: VIEW_CHART_PAD_X + index * step,
        // A view total of zero sits on the baseline; the peak sits at the top padding.
        y: baseline - (entry.views / peak) * plotHeight,
        views: entry.views,
        day: entry.day
      };
    });

    var line = points.map(function (point) {
      return point.x.toFixed(1) + ',' + point.y.toFixed(1);
    }).join(' ');
    // The area closes the line down to the baseline, so the fill reads as the volume
    // under the curve rather than as a second line.
    var area = 'M' + points[0].x.toFixed(1) + ',' + baseline + ' ' +
      points.map(function (point) { return 'L' + point.x.toFixed(1) + ',' + point.y.toFixed(1); }).join(' ') +
      ' L' + points[points.length - 1].x.toFixed(1) + ',' + baseline + ' Z';
    var dots = points.map(function (point) {
      return '<circle class="chart-dot" cx="' + point.x.toFixed(1) + '" cy="' + point.y.toFixed(1) + '" r="2.5"><title>' +
        esc(point.day) + ': ' + esc(point.views) + '</title></circle>';
    }).join('');

    // Three gridlines - the peak, the middle, and zero - each labelled at the left edge.
    var grid = [peak, Math.round(peak / 2), 0].map(function (value) {
      var y = baseline - (value / peak) * plotHeight;
      return '<line class="chart-grid" x1="' + VIEW_CHART_PAD_X + '" y1="' + y.toFixed(1) + '" x2="' +
        (VIEW_CHART_WIDTH - VIEW_CHART_PAD_X) + '" y2="' + y.toFixed(1) + '"></line>' +
        '<text class="chart-label" x="0" y="' + (y + 4).toFixed(1) + '">' + esc(value) + '</text>';
    }).join('');

    // The window the chart covers, named by its first and last day.
    var axis = '<text class="chart-label" x="' + VIEW_CHART_PAD_X + '" y="' + (VIEW_CHART_HEIGHT - 6) + '">' +
      esc(points[0].day) + '</text>' +
      '<text class="chart-label chart-label-end" x="' + (VIEW_CHART_WIDTH - VIEW_CHART_PAD_X) + '" y="' +
      (VIEW_CHART_HEIGHT - 6) + '">' + esc(points[points.length - 1].day) + '</text>';

    return '<div class="chart">' +
      '<svg viewBox="0 0 ' + VIEW_CHART_WIDTH + ' ' + VIEW_CHART_HEIGHT +
      '" role="img" aria-label="Daily views over the last ' + series.length + ' days">' +
      grid +
      '<path class="chart-area" d="' + area + '"></path>' +
      '<polyline class="chart-line" points="' + line + '"></polyline>' +
      dots + axis +
      '</svg>' +
      '<p class="small muted">Peak ' + esc(peak) + ' views in one day over the last ' + series.length + ' days.</p>' +
      '</div>';
  }

  function renderOverview() {
    var view = document.getElementById('view');
    if (!state.overview) {
      view.innerHTML = '<div class="empty">Loading…</div>';
      return;
    }
    var o = state.overview;
    // The daily view series the chart is drawn from; an older cached payload without it
    // still renders, with the chart's empty state.
    var views = o.viewsDaily || [];
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
      '<section class="card mt-18"><h2>Views (last ' + views.length + ' days)</h2>' + viewsChart(views) + '</section>' +
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
