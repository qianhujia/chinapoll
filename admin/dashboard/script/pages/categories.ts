// Categories page: create, rename, reorder, enable, and delete poll categories.

export const scriptCategories = `  function categoryOptions(selectedId) {
    var items = state.categories ? state.categories.categories : [];
    return items.map(function (item) {
      return '<option value="' + esc(item.id) + '"' + (Number(selectedId) === item.id ? ' selected' : '') + '>' +
        esc(item.name) + (item.enabled ? '' : ' (disabled)') + '</option>';
    }).join('');
  }

  function renderCategories() {
    var view = document.getElementById('view');
    var data = state.categories;
    if (!data) {
      view.innerHTML = '<section class="card"><h2>Categories</h2><div class="empty">Loading…</div></section>';
      return;
    }

    var rows = data.categories.length
      ? data.categories.map(function (item) {
          return '<tr>' +
            '<td>' + esc(item.id) + '</td>' +
            '<td><input data-cat-name data-id="' + esc(item.id) + '" value="' + esc(item.name) + '" maxlength="60"></td>' +
            '<td class="small muted">' + esc(item.slug) + '</td>' +
            '<td class="small">' + esc(item.polls) + '</td>' +
            '<td><input type="checkbox" data-cat-enabled data-id="' + esc(item.id) + '"' + (item.enabled ? ' checked' : '') + '></td>' +
            '<td><input type="number" data-cat-position data-id="' + esc(item.id) + '" value="' + esc(item.position) + '" min="0" style="width:80px"></td>' +
            '<td><div class="toolbar">' +
            '<button class="primary" data-action="save-category" data-id="' + esc(item.id) + '">Save</button>' +
            '<button data-action="delete-category" data-id="' + esc(item.id) + '">Delete</button>' +
            '</div></td></tr>';
        }).join('')
      : '<tr><td colspan="7"><div class="empty">No categories yet.</div></td></tr>';

    view.innerHTML = '<section class="card"><h2>Categories</h2>' +
      '<p class="small muted">Categories order the public home page chip row and the submit form dropdown. Deleting one keeps its polls and leaves them uncategorised. The slug is the public identifier and cannot be changed.</p>' +
      '<div class="toolbar">' +
      '<input id="new-category-slug" class="grow" placeholder="slug (a-z, 0-9, -)">' +
      '<input id="new-category-name" class="grow" placeholder="Name">' +
      '<button data-action="create-category" class="primary">Add category</button>' +
      '</div>' +
      '<table><thead><tr><th>ID</th><th>Name</th><th>Slug</th><th>Polls</th><th>Enabled</th><th>Position</th><th></th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></section>';
  }

  function loadCategories() {
    return api('/api/admin/categories').then(function (data) {
      state.categories = data;
      if (state.view === 'categories') renderCategories();
    });
  }

  function handleCategoriesAction(action, target) {
    if (action === 'create-category') {
      var slug = document.getElementById('new-category-slug').value.trim();
      var name = document.getElementById('new-category-name').value.trim();
      target.disabled = true;
      guard(api('/api/admin/categories', {
        method: 'POST',
        body: JSON.stringify({ slug: slug, name: name })
      }).then(function (result) {
        toast(result.message);
        return loadCategories();
      }).then(function () { target.disabled = false; }));
      return true;
    }
    if (action === 'save-category') {
      var id = target.getAttribute('data-id');
      var nameInput = document.querySelector('[data-cat-name][data-id="' + id + '"]');
      var enabledInput = document.querySelector('[data-cat-enabled][data-id="' + id + '"]');
      var positionInput = document.querySelector('[data-cat-position][data-id="' + id + '"]');
      target.disabled = true;
      guard(api('/api/admin/categories/' + id, {
        method: 'PUT',
        body: JSON.stringify({
          name: nameInput.value.trim(),
          enabled: enabledInput.checked,
          position: Number(positionInput.value)
        })
      }).then(function (result) {
        toast(result.message);
        return loadCategories();
      }).then(function () { target.disabled = false; }));
      return true;
    }
    if (action === 'delete-category') {
      if (!window.confirm('Delete this category? Its polls stay but become uncategorised.')) return true;
      target.disabled = true;
      guard(api('/api/admin/categories/' + target.getAttribute('data-id'), { method: 'DELETE' })
        .then(function (result) {
          toast(result.message);
          return loadCategories();
        }));
      return true;
    }
    return false;
  }`;
