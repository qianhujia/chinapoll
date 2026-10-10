import './styles.css';
import { DEFAULT_LOCALE, loadTranslations, setDefaultLocale } from './i18n';
import { mountAboutPage, mountClaimProposalPage, mountProposePage } from './pages/content';
import { mountHome } from './pages/home';
import { mountVotePage } from './pages/poll';
import { getPublicSettings, loadPublicSettings } from './config';
import { getErrorMessage, getQueryPage, getSiteName } from './ui';

const app = document.querySelector<HTMLElement>('#app');

function getCurrentRoute(): string {
  const hash = window.location.hash || '';
  const path = window.location.pathname || '/';

  if (hash.startsWith('#')) {
    const id = hash.slice(1).trim();
    if (id && /^[0-9]+$/.test(id)) {
      return `/poll/${id}`;
    }
  }

  return path === '' ? '/' : path;
}

function bindNavigation() {
  document.querySelectorAll('[data-route]').forEach((element) => {
    element.addEventListener('click', (event) => {
      event.preventDefault();
      const route = element.getAttribute('data-route') || '/';
      window.history.pushState({}, '', route);
      render();
    });
  });
}

async function render() {
  document.documentElement.lang = DEFAULT_LOCALE;
  document.title = getSiteName();
  const route = getCurrentRoute();

  if (route === '/about') {
    mountAboutPage(app!, bindNavigation);
    return;
  }

  if (route === '/propose' || route === '/propose/claim') {
    const canonicalRoute = route.replace(/^\/propose/, '/submit');
    window.history.replaceState({}, '', canonicalRoute);
    await render();
    return;
  }

  if (route === '/submit') {
    mountProposePage(app!, bindNavigation);
    return;
  }

  if (route === '/submit/claim') {
    mountClaimProposalPage(app!, bindNavigation);
    return;
  }

  if (route === '/polls') {
    await mountHome(app!, getQueryPage('page'), bindNavigation, getPublicSettings());
    return;
  }

  if (route.startsWith('/vote/')) {
    const legacyRoute = route.replace(/^\/vote\//, '/poll/');
    window.history.replaceState({}, '', legacyRoute);
    await render();
    return;
  }

  if (route.startsWith('/poll/')) {
    const issueId = Number(route.split('/').pop() ?? '11');
    await mountVotePage(Number.isSafeInteger(issueId) && issueId > 0 ? issueId : 0, app!, bindNavigation);
    return;
  }

  await mountHome(app!, getQueryPage('page'), bindNavigation, getPublicSettings());
}

window.addEventListener('popstate', () => { render(); });
async function start(): Promise<void> {
  if (!app) throw new Error('App root element not found');

  try {
    const settings = await loadPublicSettings();
    setDefaultLocale(settings.default_locale);
    document.documentElement.style.setProperty('--page-width', `${getPublicSettings().page_max_width_px}px`);
    await loadTranslations(DEFAULT_LOCALE);
    await render();
  } catch (error) {
    app.setAttribute('role', 'alert');
    app.textContent = `Could not load application settings or translations: ${getErrorMessage(error)}`;
  }
}

void start();
