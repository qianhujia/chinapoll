import { describe, expect, it } from 'vitest';
import { dashboardScript } from '../admin/dashboard/script';

// The dashboard was renamed from categories to topics. These assertions keep the
// shell, the router, and the settings page wired to the topics view so a sign-in
// at /topics (or the legacy /categories) never calls a missing renderer.
describe('admin dashboard script', () => {
  it('routes the topics view to the topics renderer', () => {
    expect(dashboardScript).toContain('renderTopics()');
    expect(dashboardScript).toContain('loadTopics()');
    expect(dashboardScript).toContain('handleTopicsAction(action, target)');
    expect(dashboardScript).not.toContain('renderCategories');
    expect(dashboardScript).not.toContain('loadCategories');
    expect(dashboardScript).not.toContain('handleCategoriesAction');
    expect(dashboardScript).not.toContain('state.categories');
  });

  it('links the nav to the topics route and keeps the legacy alias', () => {
    expect(dashboardScript).toContain("var items = ['overview', 'polls', 'topics'");
    expect(dashboardScript).toContain("topics: '/topics'");
    expect(dashboardScript).toContain("'/categories': 'topics'");
  });

  it('calls the topics endpoints', () => {
    expect(dashboardScript).toContain("'/api/admin/topics'");
    expect(dashboardScript).toContain("'/api/admin/topics/suggested'");
    expect(dashboardScript).not.toContain('/api/admin/categories');
  });

  // The fragments are concatenated into a single inline script, so a stray
  // backtick or brace in any fragment would break every dashboard page. Parsing
  // the assembled script here catches that without a browser.
  it('assembles into syntactically valid JavaScript', () => {
    expect(() => new Function(dashboardScript)).not.toThrow();
  });

  // Settings is split into pages, one per category, each linked from its own
  // sidebar sub-item instead of a tab bar.
  it('gives every settings category its own sub-page', () => {
    expect(dashboardScript).toContain('function navigateToSettingsCategory(category)');
    expect(dashboardScript).toContain('data-action="settings-category"');
    expect(dashboardScript).toContain("return '/settings/' + category;");
    for (const category of ['general', 'appearance', 'polls', 'auth', 'reports', 'ai', 'publishing', 'advanced']) {
      expect(dashboardScript).toContain("id: '" + category + "'");
    }
    expect(dashboardScript).not.toContain('switch-tab');
  });

  // The logo and favicon pickers store a base64 data URI in a hidden input, so
  // the bulk save must ignore the preview container and the Remove button.
  it('saves only form controls when a settings page is submitted', () => {
    expect(dashboardScript).toContain(
      "view.querySelectorAll('input[data-key]:not([type=\"file\"]), select[data-key], textarea[data-key]')"
    );
  });
});
