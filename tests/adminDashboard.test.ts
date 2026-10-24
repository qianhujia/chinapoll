import { describe, expect, it } from 'vitest';
import { dashboardScript } from '../admin/dashboard/script';
import { renderDashboard } from '../admin/ui';

// The root menu items, in sidebar order. Each one carries a Lucide icon.
const ROOT_VIEWS = [
  'overview',
  'polls',
  'topics',
  'reports',
  'comments',
  'users',
  'admins',
  'audit',
  'settings'
];

// The assembled script is one IIFE that boots on load. Evaluating it with a minimal
// DOM stub and the boot call removed exposes the shell renderer, so the composed
// sidebar markup can be checked without a browser.
function shellFor(view: string, section: string): string {
  const html = renderDashboard('test-nonce');
  const start = html.indexOf('(function () {');
  const end = html.lastIndexOf('})();');
  const inner = html.slice(start + '(function () {'.length, end);
  const bootIndex = inner.lastIndexOf('boot();');
  const source = inner.slice(0, bootIndex) + '/* boot disabled */' + inner.slice(bootIndex + 'boot();'.length);

  const elements = new Map<string, any>();
  const element = (): any => ({
    innerHTML: '',
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [] as any[]
  });
  const stubbedDocument = {
    getElementById: (id: string) => {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    }
  };
  const stubbedWindow = {
    location: { pathname: '/' },
    history: { pushState() {}, replaceState() {} },
    addEventListener() {}
  };

  const run = new Function('document', 'window', `${source}
    return function (view, section) {
      state.view = view;
      state.reportSection = section;
      renderShell();
    };`)(stubbedDocument, stubbedWindow) as (view: string, section: string) => void;
  run(view, section);
  return elements.get('app').innerHTML as string;
}

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

  // The icon map and the fragments are concatenated into a single inline script,
  // so a stray backtick or brace (in a fragment or in the serialized icon markup)
  // would break every dashboard page. Parsing the assembled script catches that
  // without a browser.
  it('assembles into syntactically valid JavaScript', () => {
    const html = renderDashboard('test-nonce');
    const start = html.indexOf('(function () {');
    // The IIFE that wraps the whole script is closed by the last occurrence.
    const end = html.lastIndexOf('})();');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const inlineScript = html.slice(start, end + '})();'.length);
    expect(() => new Function(inlineScript)).not.toThrow();
  });

  // Emojis were replaced by real icon shapes: one Lucide SVG per root menu item,
  // injected into the embedded script as a JSON encoded string map.
  it('gives every root menu item a Lucide SVG icon', () => {
    const html = renderDashboard('test-nonce');
    expect(html).toContain('var NAV_ICONS = {');
    for (const view of ROOT_VIEWS) {
      expect(html).toContain(`"${view}": "<svg class=`);
    }
    expect(dashboardScript).toContain("(NAV_ICONS[item] || '')");
  });

  // The icon markup is serialized as JSON, so a stray closing script tag or quote
  // in an icon can never terminate the embedded script element.
  it('keeps the icon markup inside the script element', () => {
    const html = renderDashboard('test-nonce');
    const scriptBody = html.slice(html.indexOf('<script nonce='));
    expect(scriptBody.slice(0, scriptBody.indexOf('</script>'))).not.toContain('<svg class="nav-icon"');
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

  // Reports is split into pages too: one per report queue, each linked from its own
  // sidebar sub-item instead of drawing both tables on one page.
  it('gives every report queue its own sub-page', () => {
    expect(dashboardScript).toContain('function navigateToReportSection(section)');
    expect(dashboardScript).toContain("navigateToReportSection(target.getAttribute('data-section'))");
    expect(dashboardScript).toContain('data-action="report-section"');
    expect(dashboardScript).toContain("return '/reports/' + section;");
    expect(dashboardScript).toContain("label: 'Poll reports'");
    expect(dashboardScript).toContain("label: 'Comment reports'");
    // Each queue is rendered and paged by its own function and action, so the poll
    // table and the comment table are never drawn together.
    expect(dashboardScript).toContain('function renderPollReports()');
    expect(dashboardScript).toContain('function renderCommentReports()');
    expect(dashboardScript).toContain('function reportPager(page, totalPages, total, action)');
    expect(dashboardScript).toContain("action === 'report-page'");
    expect(dashboardScript).toContain("action === 'comment-report-page'");
  });

  // A sub-nav belongs to its own sidebar link. It must never be repeated under the
  // other top-level items, which is what a missing item check in the nav map causes.
  it('renders each sub-nav only under its own sidebar link', () => {
    const reportsShell = shellFor('reports', 'comments');
    expect(reportsShell.match(/data-action="report-section"/g) ?? []).toHaveLength(2);
    expect(reportsShell).not.toContain('data-action="settings-category"');
    expect(reportsShell).toContain('data-section="polls" class="sub"');
    expect(reportsShell).toContain('data-section="comments" class="sub active"');

    const settingsShell = shellFor('settings', 'polls');
    expect(settingsShell.match(/data-action="settings-category"/g) ?? []).toHaveLength(8);
    expect(settingsShell).not.toContain('data-action="report-section"');

    // A view without sub-pages renders no sub-nav at all.
    const overviewShell = shellFor('overview', 'polls');
    expect(overviewShell).not.toContain('data-action="report-section"');
    expect(overviewShell).not.toContain('data-action="settings-category"');
  });

  // The logo and favicon pickers store a base64 data URI in a hidden input, so
  // the bulk save must ignore the preview container and the Remove button.
  it('saves only form controls when a settings page is submitted', () => {
    expect(dashboardScript).toContain(
      "view.querySelectorAll('input[data-key]:not([type=\"file\"]), select[data-key], textarea[data-key]')"
    );
  });

  // An image setting is either an uploaded file or a pasted https URL. The row
  // shows the URL the public site uses, and the pasted field writes into the same
  // hidden input that the save action collects.
  it('lets an image be uploaded or given as a URL', () => {
    expect(dashboardScript).toContain('function imagePublicUrl(item)');
    expect(dashboardScript).toContain("'/image/' + item.key + '.' + imageExtension(value)");
    expect(dashboardScript).toContain('data-image-url-display');
    expect(dashboardScript).toContain('data-image-url-for');
    // The pasted-URL field deliberately carries no data-key, so the bulk save
    // still collects only the hidden input that holds the value.
    expect(dashboardScript).toContain("data-image-url-for=\"' + esc(item.key) + '\" value=\"");
  });
});
