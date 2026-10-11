// Audit page: read the admin audit log.

export const scriptAudit = `  function renderAudit() {
    var view = document.getElementById('view');
    var data = state.audit;
    var actionOptions = '<option value="">All actions</option>';
    if (data) {
      actionOptions += data.actions.map(function (action) {
        return '<option value="' + esc(action) + '"' + (state.auditAction === action ? ' selected' : '') + '>' + esc(action) + '</option>';
      }).join('');
    }
    var toolbar = '<div class="toolbar">' +
      '<select id="audit-action" class="grow">' + actionOptions + '</select>' +
      '<input id="audit-query" class="grow" placeholder="Search actor, target, details…" value="' + esc(state.auditQuery) + '">' +
      '<button data-action="search-audit" class="primary">Search</button>' +
      '</div>';

    if (!data) {
      view.innerHTML = '<section class="card"><h2>Audit log</h2>' + toolbar + '<div class="empty">Loading…</div></section>';
      return;
    }

    var rows = data.entries.length
      ? data.entries.map(function (item) {
          return '<tr><td class="small">' + esc(formatDate(item.createdAt)) + '</td>' +
            '<td class="small">' + esc(item.actorUsername || '(system)') + '</td>' +
            '<td><strong>' + esc(item.action) + '</strong></td>' +
            '<td class="small">' + esc(item.targetType || '') + ' ' + esc(item.targetId || '') + '</td>' +
            '<td class="pre">' + esc(item.details ? JSON.stringify(item.details) : '') + '</td></tr>';
        }).join('')
      : '<tr><td colspan="5"><div class="empty">No audit entries match this filter.</div></td></tr>';

    view.innerHTML = '<section class="card"><h2>Audit log</h2>' +
      '<p class="small muted">Admin actions, including sign-ins. Client IP addresses are never recorded.</p>' +
      toolbar +
      '<table><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th><th>Details</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>' +
      '<div class="pager">' +
      '<span>Page ' + esc(data.page) + ' of ' + esc(data.totalPages) + ' · ' + esc(data.total) + ' total</span>' +
      '<button data-action="audit-page" data-dir="-1"' + (data.page <= 1 ? ' disabled' : '') + '>Previous</button>' +
      '<button data-action="audit-page" data-dir="1"' + (data.page >= data.totalPages ? ' disabled' : '') + '>Next</button>' +
      '</div></section>';
  }

  function loadAudit() {
    var path = '/api/admin/audit?page=' + state.auditPage +
      '&action=' + encodeURIComponent(state.auditAction) +
      '&q=' + encodeURIComponent(state.auditQuery);
    return api(path).then(function (data) {
      state.audit = data;
      if (state.view === 'audit') renderAudit();
    });
  }

  function handleAuditAction(action, target) {
    if (action === 'search-audit') {
      state.auditAction = document.getElementById('audit-action').value;
      state.auditQuery = document.getElementById('audit-query').value.trim();
      state.auditPage = 1; state.audit = null;
      renderAudit();
      guard(loadAudit());
      return true;
    }
    if (action === 'audit-page') {
      state.auditPage = Math.max(1, state.auditPage + Number(target.getAttribute('data-dir')));
      state.audit = null;
      renderAudit();
      guard(loadAudit());
      return true;
    }
    return false;
  }`;
