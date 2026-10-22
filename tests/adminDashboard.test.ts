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
});
