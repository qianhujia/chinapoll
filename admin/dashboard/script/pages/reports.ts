// Reports pages: one page per report queue (poll reports and comment reports).
//
// Every queue has its own URL (/reports/polls and /reports/comments) and its own
// sidebar sub-item (see core.ts and shell.ts), so this fragment renders exactly one
// table per page. The two queues page independently: the poll queue uses
// state.reportPage and the comment queue uses state.commentReportPage.

export const scriptReports = `  // The status filter both queues share. The reports endpoint applies one status to
  // the poll table and the comment table alike, so each page shows its own copy of
  // this control.
  function renderReportStatusToolbar() {
    return '<div class="toolbar">' +
      '<select id="report-status" class="grow">' +
      ['open', 'resolved', 'all'].map(function (value) {
        return '<option value="' + value + '"' + (value === state.reportStatus ? ' selected' : '') + '>' + value + '</option>';
      }).join('') +
      '</select>' +
      '<button data-action="search-reports" class="primary">Apply</button>' +
      '</div>';
  }

  // The pager for one queue. Each queue carries its own page number, page count,
  // and total, and names its own action, so the two tables page independently.
  function reportPager(page, totalPages, total, action) {
    return '<div class="pager">' +
      '<span>Page ' + esc(page) + ' of ' + esc(totalPages) + ' · ' + esc(total) + ' total</span>' +
      '<button data-action="' + action + '" data-dir="-1"' + (page <= 1 ? ' disabled' : '') + '>Previous</button>' +
      '<button data-action="' + action + '" data-dir="1"' + (page >= totalPages ? ' disabled' : '') + '>Next</button>' +
      '</div>';
  }

  function renderPollReports() {
    var view = document.getElementById('view');
    var data = state.reports;
    var toolbar = renderReportStatusToolbar();

    if (!data) {
      view.innerHTML = '<section class="card"><h2>Poll reports</h2>' + toolbar + '<div class="empty">Loading…</div></section>';
      return;
    }

    var rows = data.reports.length
      ? data.reports.map(function (item) {
          var title = esc(item.pollTitle || '(no title)');
          if (state.publicSiteOrigin) {
            title = '<a href="' + esc(state.publicSiteOrigin) + '/poll/' + esc(item.pollId) + '" target="_blank" rel="noopener">' + title + '</a>';
          }
          var priorityBadge = item.priority ? ' <span class="badge priority">priority</span>' : '';
          var reasons = item.reasons.filter(function (entry) { return entry.count > 0; })
            .map(function (entry) { return esc(entry.reason) + ' (' + esc(entry.count) + ')'; })
            .join(', ') || '<span class="muted">none</span>';
          var notes = item.notes.length
            ? '<div class="small muted">' + item.notes.map(function (note) { return esc(note); }).join('<br>') + '</div>'
            : '';
          return '<tr' + (item.priority ? ' class="row-priority"' : '') + '>' +
            '<td>' + esc(item.pollId) + '</td>' +
            '<td>' + title + priorityBadge + '</td>' +
            '<td class="small">' + esc(item.openCount) + ' / ' + esc(item.totalCount) + '</td>' +
            '<td class="desc">' + reasons + notes + '</td>' +
            '<td><div class="actions">' +
              '<button class="ok" data-action="resolve-report" data-id="' + item.pollId + '" data-resolution="action_taken">Action taken</button>' +
              '<button data-action="resolve-report" data-id="' + item.pollId + '" data-resolution="dismissed">Dismiss</button>' +
            '</div></td></tr>';
        }).join('')
      : '<tr><td colspan="5"><div class="empty">No reports match this filter.</div></td></tr>';

    view.innerHTML = '<section class="card"><h2>Poll reports</h2>' + toolbar +
      '<table><thead><tr><th>Poll</th><th>Title</th><th>Open / Total</th><th>Reasons</th><th>Action</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>' +
      reportPager(data.page, data.totalPages, data.total, 'report-page') +
      '</section>';
  }

  function renderCommentReports() {
    var view = document.getElementById('view');
    var data = state.reports;
    var toolbar = renderReportStatusToolbar();

    if (!data) {
      view.innerHTML = '<section class="card"><h2>Comment reports</h2>' + toolbar + '<div class="empty">Loading…</div></section>';
      return;
    }

    var rows = (data.commentReports || []).length
      ? data.commentReports.map(function (item) {
          var reasons = item.reasons.filter(function (entry) { return entry.count > 0; })
            .map(function (entry) { return esc(entry.reason) + ' (' + esc(entry.count) + ')'; })
            .join(', ') || '<span class="muted">none</span>';
          var notes = item.notes.length
            ? '<div class="small muted">' + item.notes.map(function (note) { return esc(note); }).join('<br>') + '</div>'
            : '';
          var pollLink = esc(item.pollId);
          if (state.publicSiteOrigin) {
            pollLink = '<a href="' + esc(state.publicSiteOrigin) + '/poll/' + esc(item.pollId) + '" target="_blank" rel="noopener">' + esc(item.pollId) + '</a>';
          }
          var priorityBadge = item.priority ? ' <span class="badge priority">priority</span>' : '';
          return '<tr' + (item.priority ? ' class="row-priority"' : '') + '>' +
            '<td class="desc">' + esc(item.comment) + priorityBadge + '</td>' +
            '<td>' + pollLink + '</td>' +
            '<td class="small">' + esc(item.openCount) + ' / ' + esc(item.totalCount) + '</td>' +
            '<td class="desc">' + reasons + notes + '</td>' +
            '<td><div class="actions">' +
              '<button class="ok" data-action="resolve-comment-report" data-id="' + esc(item.commentId) + '" data-resolution="action_taken">Action taken</button>' +
              '<button data-action="resolve-comment-report" data-id="' + esc(item.commentId) + '" data-resolution="dismissed">Dismiss</button>' +
            '</div></td></tr>';
        }).join('')
      : '<tr><td colspan="5"><div class="empty">No comment reports match this filter.</div></td></tr>';

    view.innerHTML = '<section class="card"><h2>Comment reports</h2>' +
      '<p class="small muted">A reported comment is reviewed by hand: there is no automatic threshold, because hiding a comment on a report count is cheap to abuse from one network. Delete the comment from the Comments tab when action is needed.</p>' +
      toolbar +
      '<table><thead><tr><th>Comment</th><th>Poll</th><th>Open / Total</th><th>Reasons</th><th>Action</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>' +
      reportPager(data.commentPage, data.commentTotalPages, data.commentTotal, 'comment-report-page') +
      '</section>';
  }

  // The open queue decides which table is drawn; the shell calls renderReports.
  function renderReports() {
    if (state.reportSection === 'comments') renderCommentReports();
    else renderPollReports();
  }

  function loadReports() {
    var path = '/api/admin/reports?status=' + encodeURIComponent(state.reportStatus) +
      '&page=' + state.reportPage +
      '&commentsPage=' + state.commentReportPage;
    return api(path).then(function (data) {
      state.reports = data;
      if (state.view === 'reports') renderReports();
    });
  }

  function handleReportsAction(action, target) {
    if (action === 'search-reports') {
      state.reportStatus = document.getElementById('report-status').value;
      state.reportPage = 1; state.commentReportPage = 1; state.reports = null;
      renderReports();
      guard(loadReports());
      return true;
    }
    if (action === 'report-page') {
      state.reportPage = Math.max(1, state.reportPage + Number(target.getAttribute('data-dir')));
      state.reports = null;
      renderReports();
      guard(loadReports());
      return true;
    }
    if (action === 'resolve-report') {
      var pollId = target.getAttribute('data-id');
      var resolution = target.getAttribute('data-resolution');
      if (!window.confirm('Mark every open report for poll ' + pollId + ' as ' + resolution + '?')) return true;
      target.disabled = true;
      guard(api('/api/admin/reports/' + pollId + '/resolve', {
        method: 'POST',
        body: JSON.stringify({ resolution: resolution })
      }).then(function (result) {
        toast(result.message);
        return Promise.all([loadReports(), loadOverview()]);
      }));
      return true;
    }
    if (action === 'comment-report-page') {
      state.commentReportPage = Math.max(1, state.commentReportPage + Number(target.getAttribute('data-dir')));
      state.reports = null;
      renderReports();
      guard(loadReports());
      return true;
    }
    if (action === 'resolve-comment-report') {
      var commentId = target.getAttribute('data-id');
      var commentResolution = target.getAttribute('data-resolution');
      if (!window.confirm('Mark every open report for comment ' + commentId + ' as ' + commentResolution + '?')) return true;
      target.disabled = true;
      guard(api('/api/admin/comment-reports/' + commentId + '/resolve', {
        method: 'POST',
        body: JSON.stringify({ resolution: commentResolution })
      }).then(function (result) {
        toast(result.message);
        return Promise.all([loadReports(), loadOverview()]);
      }));
      return true;
    }
    return false;
  }`;
