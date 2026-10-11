// Comments page: search and delete comments.

export const scriptComments = `  function renderComments() {
    var view = document.getElementById('view');
    var data = state.comments;
    var toolbar = '<div class="toolbar">' +
      '<input id="comment-poll" class="grow" placeholder="Filter by poll ID" value="' + esc(state.commentPollId) + '">' +
      '<input id="comment-query" class="grow" placeholder="Search comment text…" value="' + esc(state.commentQuery) + '">' +
      '<button data-action="search-comments" class="primary">Search</button>' +
      '</div>';

    if (!data) {
      view.innerHTML = '<section class="card"><h2>Comments</h2>' + toolbar + '<div class="empty">Loading…</div></section>';
      return;
    }

    var rows = data.comments.length
      ? data.comments.map(function (item) {
          return '<tr><td>' + esc(item.id) + '</td>' +
            '<td class="desc">' + esc(item.comment) + '</td>' +
            '<td class="small">' + esc(item.pollId) + '<div class="muted">' + esc(item.pollTitle || '(unknown poll)') + '</div></td>' +
            '<td class="small">' + esc(formatDate(item.createdAt)) + '</td>' +
            '<td><button class="danger" data-action="delete-comment" data-id="' + item.id + '">Delete</button></td></tr>';
        }).join('')
      : '<tr><td colspan="5"><div class="empty">No comments match this filter.</div></td></tr>';

    view.innerHTML = '<section class="card"><h2>Comments</h2>' + toolbar +
      '<table><thead><tr><th>ID</th><th>Comment</th><th>Poll</th><th>Created</th><th>Action</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>' +
      '<div class="pager">' +
      '<span>Page ' + esc(data.page) + ' of ' + esc(data.totalPages) + ' · ' + esc(data.total) + ' total</span>' +
      '<button data-action="comment-page" data-dir="-1"' + (data.page <= 1 ? ' disabled' : '') + '>Previous</button>' +
      '<button data-action="comment-page" data-dir="1"' + (data.page >= data.totalPages ? ' disabled' : '') + '>Next</button>' +
      '</div></section>';
  }

  function loadComments() {
    var path = '/api/admin/comments?page=' + state.commentPage +
      '&q=' + encodeURIComponent(state.commentQuery) +
      '&pollId=' + encodeURIComponent(state.commentPollId);
    return api(path).then(function (data) {
      state.comments = data;
      if (state.view === 'comments') renderComments();
    });
  }

  function handleCommentsAction(action, target) {
    if (action === 'delete-comment') {
      var commentId = target.getAttribute('data-id');
      if (!window.confirm('Delete comment ' + commentId + '?')) return true;
      target.disabled = true;
      guard(api('/api/admin/comments/' + commentId, { method: 'DELETE' }).then(function (result) {
        toast(result.message);
        return Promise.all([loadComments(), loadOverview()]);
      }));
      return true;
    }
    if (action === 'search-comments') {
      state.commentPollId = document.getElementById('comment-poll').value.trim();
      state.commentQuery = document.getElementById('comment-query').value.trim();
      state.commentPage = 1; state.comments = null;
      renderComments();
      guard(loadComments());
      return true;
    }
    if (action === 'comment-page') {
      state.commentPage = Math.max(1, state.commentPage + Number(target.getAttribute('data-dir')));
      state.comments = null;
      renderComments();
      guard(loadComments());
      return true;
    }
    return false;
  }`;
