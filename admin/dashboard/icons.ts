// Lucide icon markup for the dashboard's top level navigation.
//
// The dashboard is served as one self-contained HTML document with no build step
// and no runtime dependencies (see ../ui.ts), so the icon shapes are rendered to
// SVG markup here, on the Worker side, and injected into the embedded client
// script as a plain string map. The shapes come from the same `lucide` package
// the public site uses (see src/ui.ts), so both front ends stay visually
// consistent. The `lucide` entry point only re-exports one module per icon, so
// the bundle grows by the icons that are actually used.

import {
  Flag,
  LayoutDashboard,
  MessageSquare,
  ScrollText,
  Settings,
  ShieldCheck,
  Tags,
  Users,
  Vote,
  type IconNode
} from 'lucide';

// Icon nodes are inlined into SVG markup at load time; no icon library ships at
// runtime. `stroke="currentColor"` keeps an icon in step with its link's color
// (including the active and hover states).
function iconMarkup(node: IconNode, cssClass: string): string {
  const children = node.map(([tag, attrs]) => {
    const attributes = Object.entries(attrs)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([name, value]) => ` ${name}="${value}"`)
      .join('');
    return `<${tag}${attributes} />`;
  }).join('');
  return `<svg class="${cssClass}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${children}</svg>`;
}

// One icon per top level dashboard view, keyed by the view id used by the client
// router (see script/core.ts and the nav items in script/shell.ts).
const DASHBOARD_NAV_ICONS: Record<string, IconNode> = {
  overview: LayoutDashboard,
  polls: Vote,
  topics: Tags,
  reports: Flag,
  comments: MessageSquare,
  users: Users,
  admins: ShieldCheck,
  audit: ScrollText,
  settings: Settings
};

// The icon map as a client-side script fragment. Built once at module load; the
// values are JSON encoded so the SVG markup cannot break out of the string.
export const dashboardNavIconsScript = `  var NAV_ICONS = {\n${
  Object.entries(DASHBOARD_NAV_ICONS)
    .map(([view, node]) => `    ${JSON.stringify(view)}: ${JSON.stringify(iconMarkup(node, 'nav-icon'))}`)
    .join(',\n')
}\n  };\n`;
