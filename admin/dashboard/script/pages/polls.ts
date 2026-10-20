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

  function optionSummary(item) {
    if (!item.options || item.options.length === 0) return '';
    var list = item.options.map(function (option) {
      return esc(option.position) + '. ' + esc(option.label) + ' (' + esc(option.count) + ')';
    }).join(' · ');
    return '<div class="small muted">' + list + '</div>';
  }

  // Option rows may only be edited while a poll is still pending and has no
  // ballots. Saving replaces the set by position.
  function optionEditor(item) {
    var rows = item.options.map(function (option) {
      return '<div class="option-row" data-option-position="' + esc(option.position) + '">' +
        '<input class="grow" data-option-label value="' + esc(option.label) + '" maxlength="80">' +
        '<span class="small muted">' + esc(option.count) + '</span>' +
        '</div>';
    }).join('');
    return '<div class="option-editor" data-option-editor="' + esc(item.id) + '">' + rows +
      '<div class="toolbar"><button class="primary" data-action="save-poll-options" data-id="' + esc(item.id) + '">Save options</button>' +
      '<span class="small muted">Editable while the poll is pending with no ballots. The count column is read-only.</span></div></div>';
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
          var categorySelect = '<select class="poll-category-select" data-action="poll-category" data-id="' + item.id + '">' +
            '<option value="">(no category)</option>' + categoryOptions(item.categoryId) + '</select>';
          var expanded = state.expandedPolls.indexOf(item.id) !== -1;
          var titleCell = '<strong>' + esc(item.title || '(no title)') + '</strong>' +
            '<div class="small muted">' + esc(item.mode) + ' · ' + esc(item.pollType) + '</div>' + optionSummary(item);
          if (item.options && item.options.length > 0) {
            titleCell += '<div class="small"><button data-action="toggle-poll-options" data-id="' + esc(item.id) + '">' +
              (expanded ? 'Hide options' : 'Show options') + '</button></div>';
            if (expanded) titleCell += optionEditor(item);
          }
          return '<tr><td>' + esc(item.id) + '</td>' +
            '<td>' + titleCell + '</td>' +
            '<td><span class="badge ' + esc(item.status) + '">' + esc(item.status) + '</span></td>' +
            '<td class="small">' + esc(item.ballots) + '</td>' +
            '<td class="small">' + esc(item.views) + '</td>' +
            '<td style="min-width:160px">' + categorySelect + '</td>' +
            '<td style="min-width:150px">' + selector + '</td></tr>';
        }).join('')
      : '<tr><td colspan="6"><div class="empty">No polls match this filter.</div></td></tr>';

    view.innerHTML = '<section class="card"><h2>Polls</h2>' + toolbar +
      '<table><thead><tr><th>ID</th><th>Title</th><th>Status</th><th>Ballots</th><th>Views</th><th>Category</th><th>Change status</th></tr></thead>' +
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
    // The category selector needs the category list alongside the page.
    return Promise.all([api(path), api('/api/admin/categories')]).then(function (results) {
      state.polls = results[0];
      state.categories = results[1];
      if (state.view === 'polls') renderPolls();
    });
  }

  function savePollOptions(id, target) {
    var editor = document.querySelector('[data-option-editor="' + id + '"]');
    if (!editor) return;
    // Every poll replaces its labels by position.
    var inputs = editor.querySelectorAll('[data-option-label]');
    var options = [];
    for (var index = 0; index < inputs.length; index += 1) {
      var row = inputs[index].closest('[data-option-position]');
      var position = row ? Number(row.getAttribute('data-option-position')) : index + 1;
      options.push({ position: position, label: inputs[index].value.trim() });
    }
    submitPollOptions(id, target, { options: options });
  }
  // Sends one option-set change and refreshes the listing.
  function submitPollOptions(id, target, body) {
    target.disabled = true;
    guard(api('/api/admin/polls/' + id + '/options', {
      method: 'PUT',
      body: JSON.stringify(body)
    }).then(function (result) {
      toast(result.message);
      return loadPolls();
    }).then(function () { target.disabled = false; }));
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
    if (action === 'toggle-poll-options') {
      var toggleId = Number(target.getAttribute('data-id'));
      var at = state.expandedPolls.indexOf(toggleId);
      if (at === -1) state.expandedPolls.push(toggleId);
      else state.expandedPolls.splice(at, 1);
      renderPolls();
      return true;
    }
    if (action === 'save-poll-options') {
      savePollOptions(target.getAttribute('data-id'), target);
      return true;
    }
    return false;
  }
  function handlePollsChange(target) {
    var id = target.getAttribute('data-id');
    if (target.getAttribute('data-action') === 'poll-category') {
      guard(api('/api/admin/polls/' + id + '/category', {
        method: 'PUT',
        body: JSON.stringify({ categoryId: target.value === '' ? null : Number(target.value) })
      }).then(function (result) {
        toast(result.message);
        return loadPolls();
      }));
      return;
    }
    guard(api('/api/admin/polls/' + id + '/status', {
      method: 'POST',
      body: JSON.stringify({ status: target.value })
    }).then(function (result) {
      toast(result.message);
      return Promise.all([loadPolls(), loadOverview()]);
    }));
  }`;
