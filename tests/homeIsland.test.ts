// The home page's server-provided data.
//
// The topic chip row and the poll list are server-rendered: the document's
// bootstrap island carries the `GET /api/topics` body and the `GET /api/polls`
// body for the exact view, so the first load renders both without those requests.
// Only a client-side route change, which serves no new document and therefore
// carries no matching island, falls back to the endpoints.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { BOOTSTRAP_ELEMENT_ID } from '../src/bootstrap';
import { loadTranslations } from '../src/i18n';
import { mountHome } from '../src/pages/home';
import en from '../public/i18n/en.json';

const TOPICS = {
  topics: [
    {
      id: 1,
      slug: 'politics',
      name: 'Politics',
      description: null,
      position: 1,
      names: { en: 'Politics', 'zh-CN': '政治', 'zh-TW': '政治' },
      count: 3
    }
  ],
  total: 3
};

// One poll row shaped like the `/api/polls` page response, with the ballot total
// and the topic the home list shows.
const POLLS = {
  polls: [
    {
      poll: {
        id: 7,
        number: 42,
        title: 'Should the city build more bike lanes?',
        description: null,
        mode: 'evergreen',
        pollType: 'single_choice',
        options: [],
        start_at: null,
        status: 'open',
        topic: null
      },
      stats: { pollId: 7, pollType: 'single_choice', ballots: 12, hidden: false, threshold: 0, options: [], voted: false },
      views: null
    }
  ],
  page: 1,
  pageSize: 15,
  total: 1,
  query: '',
  totalPolls: 1,
  totalVotes: 12
};

// The island a poll-list route carries: the topics and the poll list for this view.
function listIsland(): string {
  return JSON.stringify({ topics: TOPICS, polls: { page: 1, query: '', topic: '', body: POLLS } });
}

// Stands in for the document: the island reader only needs getElementById, and the
// header reads the query string from window.location.
function stubDocument(island: string | null): void {
  vi.stubGlobal('document', {
    getElementById: (id: string) => (id === BOOTSTRAP_ELEMENT_ID && island !== null
      ? { textContent: island }
      : null)
  });
  vi.stubGlobal('window', { location: { search: '' } });
}

// Records every request and answers the dictionary and both list endpoints.
function stubFetch(calls: string[]): void {
  vi.stubGlobal('fetch', async (input: string) => {
    calls.push(input);
    if (input === '/i18n/en.json') return { ok: true, json: async () => en };
    if (input.startsWith('/api/topics')) return { ok: true, json: async () => TOPICS };
    return { ok: true, json: async () => POLLS };
  });
}

function makeApp(): HTMLElement {
  // The chip toggle is looked up on the rendered element; there is no toggle when
  // every topic fits, so returning null is enough for this environment.
  return { innerHTML: '', querySelector: () => null } as unknown as HTMLElement;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('home server-provided data', () => {
  it('renders the chips and the list from the island without calling the endpoints', async () => {
    const calls: string[] = [];
    stubDocument(listIsland());
    stubFetch(calls);
    await loadTranslations('en');

    const app = makeApp();
    await mountHome(app, 1, () => {}, undefined);

    expect(calls.some((url) => url.startsWith('/api/polls'))).toBe(false);
    expect(calls.some((url) => url.startsWith('/api/topics'))).toBe(false);
    // The chip row and the poll row both came from the island.
    expect(app.innerHTML).toContain('data-topic-chips');
    expect(app.innerHTML).toContain('Politics');
    expect(app.innerHTML).toContain('Should the city build more bike lanes?');
    // The vote count is the ballot icon and the number, and the view count is not
    // part of the list.
    expect(app.innerHTML).toContain('data-vote-count');
    expect(app.innerHTML).not.toContain('title="views"');
  });

  it('falls back to the endpoints when the document carries no island data', async () => {
    const calls: string[] = [];
    stubDocument(null);
    stubFetch(calls);
    await loadTranslations('en');

    const app = makeApp();
    await mountHome(app, 1, () => {}, undefined);

    expect(calls.some((url) => url.startsWith('/api/polls'))).toBe(true);
    expect(calls.some((url) => url.startsWith('/api/topics'))).toBe(true);
    expect(app.innerHTML).toContain('data-topic-chips');
    expect(app.innerHTML).toContain('Should the city build more bike lanes?');
  });
});
