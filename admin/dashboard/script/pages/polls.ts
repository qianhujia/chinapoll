// Polls page: view, review submissions, and change poll status.

export const scriptPolls = `  function statusOptions(selected, includeAll, includePending) {
    var values = [];
    if (includePending) values.push('pending');
    values.push('open', 'closed', 'archived');
    if (includeAll) values.push('all');
    return values.map(function (value) {
      return '<option value="' + value + '"' + (value === selected ? ' selected' : '') + '>' + value + '</option>';
    }).join('');
  }

  function renderPolls() {
    var view = document.getElementById('view');
    var data = state.polls;
    var toolbar = '<div class="toolbar">' +
      '<select id="poll-status" class="grow">' + statusOptions(state.pollStatus, true, true) + '</select>' +
      '<input id="poll-query" class="grow" placeholder="Search titles…" value="' + esc(state.pollQuery) + '">' +
      '<button data-action="search-polls" class="primary">Search</button>' +
      '</div>';

    if (!data) {
      view.innerHTML = '<section class="card"><h2>Polls</h2>' + toolbar + '<div class="empty">Loading…</div></section>';
      return;
    }

    var rows = data.polls.length
      ? data.polls.map(function (item) {
          var selector = '<select class="poll-status-select" data-action="poll-status" data-id="' + item.id + '">' +
            statusOptions(item.status, false, true) + '</select>';
          return '<tr><td>' + esc(item.id) + '</td>' +
            '<td><strong>' + esc(item.title || '(no title)') + '</strong>' +
            '<div class="small muted">' + esc(item.mode) + '</div></td>' +
            '<td><span class="badge ' + esc(item.status) + '">' + esc(item.status) + '</span></td>' +
            '<td class="small">' + esc(item.counts.approve) + ' / ' + esc(item.counts.neutral) + ' / ' + esc(item.counts.oppose) + '</td>' +
            '<td class="small">' + esc(item.views) + '</td>' +
            '<td style="min-width:150px">' + selector + '</td></tr>';
        }).join('')
      : '<tr><td colspan="6"><div class="empty">No polls match this filter.</div></td></tr>';

    view.innerHTML = '<section class="card"><h2>Polls</h2>' + toolbar +
      '<table><thead><tr><th>ID</th><th>Title</th><th>Status</th><th>Approve / Neutral / Oppose</th><th>Views</th><th>Change status</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>' +
      '<div class="pager">' +
      '<span>Page ' + esc(data.page) + ' of ' + esc(data.totalPages) + ' · ' + esc(data.total) + ' total</span>' +
      '<button data-action="poll-page" data-dir="-1"' + (data.page <= 1 ? ' disabled' : '') + '>Previous</button>' +
      '<button data-action="poll-page" data-dir="1"' + (data.page >= data.totalPages ? ' disabled' : '') + '>Next</button>' +
      '</div></section>';
  }

  function loadPolls() {
    var path = '/api/admin/polls?status=' + encodeURIComponent(state.pollStatus) +
      '&page=' + state.pollPage + '&q=' + encodeURIComponent(state.pollQuery);
    return api(path).then(function (data) {
      state.polls = data;
      if (state.view === 'polls') renderPolls();
    });
  }

  function handlePollsAction(action, target) {
    if (action === 'search-polls') {
      state.pollQuery = document.getElementById('poll-query').value.trim();
      state.pollStatus = document.getElementById('poll-status').value;
      state.pollPage = 1; state.polls = null;
      renderPolls();
      guard(loadPolls());
      return true;
    }
    if (action === 'poll-page') {
      state.pollPage = Math.max(1, state.pollPage + Number(target.getAttribute('data-dir')));
      state.polls = null;
      renderPolls();
      guard(loadPolls());
      return true;
    }
    return false;
  }
  function handlePollsChange(target) {
    var id = target.getAttribute('data-id');
    guard(api('/api/admin/polls/' + id + '/status', {
      method: 'POST',
      body: JSON.stringify({ status: target.value })
    }).then(function (result) {
      toast(result.message);
      return Promise.all([loadPolls(), loadOverview()]);
    }));
  }`;
