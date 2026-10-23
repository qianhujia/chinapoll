// Topics page: create, rename, reorder, enable, and delete poll topics.

export const scriptTopics = `  function topicOptions(selectedId) {
    var items = state.topics ? state.topics.topics : [];
    return items.map(function (item) {
      return '<option value="' + esc(item.id) + '"' + (Number(selectedId) === item.id ? ' selected' : '') + '>' +
        esc(item.name) + (item.enabled ? '' : ' (disabled)') + '</option>';
    }).join('');
  }

  function renderTopics() {
    var view = document.getElementById('view');
    var data = state.topics;
    if (!data) {
      view.innerHTML = '<section class="card"><h2>Topics</h2><div class="empty">Loading…</div></section>';
      return;
    }

    var rows = data.topics.length
      ? data.topics.map(function (item) {
          return '<tr>' +
            '<td>' + esc(item.id) + '</td>' +
            '<td><input data-topic-name data-id="' + esc(item.id) + '" value="' + esc(item.name) + '" maxlength="60"></td>' +
            '<td><textarea data-topic-description data-id="' + esc(item.id) + '" maxlength="500" class="w-full rounded border border-border bg-panel px-2 py-1 text-sm" rows="2" placeholder="Description">' + esc(item.description || '') + '</textarea></td>' +
            '<td class="small muted">' + esc(item.slug) + '</td>' +
            '<td class="small">' + esc(item.polls) + '</td>' +
            '<td><input type="checkbox" data-topic-enabled data-id="' + esc(item.id) + '"' + (item.enabled ? ' checked' : '') + '></td>' +
            '<td><input type="number" data-topic-position data-id="' + esc(item.id) + '" value="' + esc(item.position) + '" min="0" class="w-80"></td>' +
            '<td><div class="toolbar">' +
            '<button class="primary" data-action="save-topic" data-id="' + esc(item.id) + '">Save</button>' +
            '<button data-action="delete-topic" data-id="' + esc(item.id) + '">Delete</button>' +
            '</div></td></tr>';
        }).join('')
      : '<tr><td colspan="8"><div class="empty">No topics yet.</div></td></tr>';

    view.innerHTML = '<section class="card"><h2>Topics</h2>' +
      '<p class="small muted">Topics order the public home page chip row and the submit form dropdown. Deleting one keeps its polls and leaves them untopicalized. The slug is the public identifier and cannot be changed.</p>' +
      '<div class="toolbar">' +
      '<input id="new-topic-slug" class="grow" placeholder="slug (a-z, 0-9, -)">' +
      '<input id="new-topic-name" class="grow" placeholder="Name">' +
      '<input id="new-topic-description" class="grow" placeholder="Description (optional)" maxlength="500">' +
      '<button data-action="create-topic" class="primary">Add topic</button>' +
      '<button data-action="insert-suggested-topics">Insert suggested topics</button>' +
      '</div>' +
      '<table><thead><tr><th>ID</th><th>Name</th><th>Description</th><th>Slug</th><th>Polls</th><th>Enabled</th><th>Position</th><th></th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></section>';
  }

  function loadTopics() {
    return api('/api/admin/topics').then(function (data) {
      state.topics = data;
      if (state.view === 'topics') renderTopics();
    });
  }

  function handleTopicsAction(action, target) {
    if (action === 'create-topic') {
      var slug = document.getElementById('new-topic-slug').value.trim();
      var name = document.getElementById('new-topic-name').value.trim();
      var description = document.getElementById('new-topic-description').value.trim();
      target.disabled = true;
      guard(api('/api/admin/topics', {
        method: 'POST',
        body: JSON.stringify({ slug: slug, name: name, description: description })
      }).then(function (result) {
        toast(result.message);
        return loadTopics();
      }).then(function () { target.disabled = false; }));
      return true;
    }
    if (action === 'save-topic') {
      var id = target.getAttribute('data-id');
      var nameInput = document.querySelector('[data-topic-name][data-id="' + id + '"]');
      var descriptionInput = document.querySelector('[data-topic-description][data-id="' + id + '"]');
      var enabledInput = document.querySelector('[data-topic-enabled][data-id="' + id + '"]');
      var positionInput = document.querySelector('[data-topic-position][data-id="' + id + '"]');

      if (!nameInput || !descriptionInput || !enabledInput || !positionInput) {
        toast('Topic row not found. Please refresh and try again.', true);
        return true;
      }

      target.disabled = true;
      guard(api('/api/admin/topics/' + id, {
        method: 'PUT',
        body: JSON.stringify({
          name: nameInput.value.trim(),
          description: descriptionInput.value.trim(),
          enabled: enabledInput.checked,
          position: Number(positionInput.value)
        })
      }).then(function (result) {
        toast(result.message);
        return loadTopics();
      }).then(function () { target.disabled = false; }));
      return true;
    }
    if (action === 'delete-topic') {
      if (!window.confirm('Delete this topic? Its polls stay but become untopicalized.')) return true;
      target.disabled = true;
      guard(api('/api/admin/topics/' + target.getAttribute('data-id'), { method: 'DELETE' })
        .then(function (result) {
          toast(result.message);
          return loadTopics();
        }));
      return true;
    }
    if (action === 'insert-suggested-topics') {
      if (!window.confirm('Insert the suggested topics (politics, economy, education, environment, health, technology, culture, society, other)?')) return true;
      target.disabled = true;
      guard(api('/api/admin/topics/suggested', { method: 'POST' }).then(function (result) {
        toast(result.message);
        return loadTopics();
      }).then(function () { target.disabled = false; }));
      return true;
    }
    return false;
  }`;