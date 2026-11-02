// Submit-page contact notice tests.
//
// The submit page is built on the client, so mounting it is what shows whether the
// notice appears where a visitor needs it: above the poll type field for a visitor
// who is signed in, and in the sign-in prompt for one who is not. The page only
// assigns markup and hands its bindings a delegate, so a plain element stub (a
// target for `innerHTML` whose `querySelector` finds nothing) renders it fully, the
// way `tests/adminDashboard.test.ts` renders the dashboard shell.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mountProposePage } from '../src/pages/content';
import { loadPublicSettings } from '../src/config';
import { loadSession } from '../src/lib/session';
import { loadTranslations } from '../src/i18n';
import { DEFAULT_PUBLIC_SETTINGS, publicSettingsPayload } from '../worker/api/settings';
import en from '../public/i18n/en.json';

const ADDRESS = 'polls@example.com';

beforeEach(() => {
  // The header reads the search query from the address bar.
  vi.stubGlobal('window', { location: { search: '' } });
});

// Mounts the page the way the app does: the payload the Worker builds, then the
// translations and the session, then the render. The serialized payload is returned
// alongside the rendered page so a test can check what the browser actually received.
async function renderSubmitPage(signedIn: boolean, email: string): Promise<{ html: string; payload: string }> {
  const settings = publicSettingsPayload({ ...DEFAULT_PUBLIC_SETTINGS, submit_contact_email: email }, {});
  vi.stubGlobal('fetch', async (input: string) => {
    if (input === '/api/settings/public') return { ok: true, json: async () => settings };
    if (input === '/api/auth/session') {
      const user = { id: 1, username: 'ada', createdAt: '2026-01-01T00:00:00Z' };
      return { ok: true, json: async () => ({ authenticated: signedIn, user: signedIn ? user : null }) };
    }
    if (input === '/i18n/en.json') return { ok: true, json: async () => en };
    throw new Error(`unexpected request ${input}`);
  });

  await loadPublicSettings();
  await loadTranslations('en');
  await loadSession();

  const app = { innerHTML: '', querySelector: () => null } as unknown as HTMLElement;
  mountProposePage(app, () => {});
  return { html: app.innerHTML, payload: JSON.stringify(settings) };
}

describe('submit page contact notice', () => {
  it('offers the address above the poll type field', async () => {
    const { html } = await renderSubmitPage(true, ADDRESS);

    // The notice sits in the form, ahead of the first legend, which is the poll
    // type fieldset's.
    const notice = html.indexOf('data-contact-email');
    expect(notice).toBeGreaterThan(-1);
    expect(notice).toBeLessThan(html.indexOf('<legend'));
    expect(html).toContain(`href="mailto:${ADDRESS}"`);
    expect(html).toContain('Do not want to register?');
  });

  // A harvester reads the document the site serves, and the address it offers is
  // only ever encoded there; the link is built by the page from the decoded value.
  it('keeps the address out of the payload the browser receives', async () => {
    const { html, payload } = await renderSubmitPage(true, ADDRESS);

    expect(payload).not.toContain(ADDRESS);
    expect(payload).not.toContain('mailto:');
    expect(payload).not.toContain('@');
    // The page still links the address it read back.
    expect(html).toContain(`href="mailto:${ADDRESS}"`);
    expect(html).toContain(`>${ADDRESS}</a>`);
  });

  it('shows no notice while no address is configured', async () => {
    const { html } = await renderSubmitPage(true, '');

    expect(html).not.toContain('data-contact-email');
    expect(html).not.toContain('mailto:');
    // The rest of the form is unchanged.
    expect(html).toContain('<legend');
  });

  it('offers the address to a visitor who is not signed in', async () => {
    const { html } = await renderSubmitPage(false, ADDRESS);

    // The prompt asks for an account and then names the way around it, after the
    // link that leads to the sign-in page.
    expect(html).toContain('You need an account to submit a poll.');
    expect(html.indexOf('data-contact-email')).toBeGreaterThan(html.indexOf('data-route="/login"'));
    expect(html).toContain(`href="mailto:${ADDRESS}"`);
    // Without a session there is no form to submit.
    expect(html).not.toContain('<legend');
  });
});