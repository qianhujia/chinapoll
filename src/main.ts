import './styles.css';
import { DEFAULT_LOCALE, loadTranslations, setDefaultLocale } from './i18n';
import { mountAboutPage, mountProposePage } from './pages/content';
import { ACCOUNT_SECTIONS, accountSectionFromRoute, mountAccountPage } from './pages/account';
import { mountLoginPage, mountRegisterPage, mountResetPage } from './pages/auth';
import { mountHome } from './pages/home';
import { mountVotePage } from './pages/poll';
import { getPublicSettings, loadPublicSettings } from './config';
import { loadSession } from './lib/session';
import { bindHeaderSearch, setSearchNavigator } from './search';
import { applyFavicon, getErrorMessage, getQueryPage, getSiteName } from './ui';
import { updateSeo, getSeoForRoute } from './seo';

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

function navigateTo(route: string): void {
  window.history.pushState({}, '', route);
  void render();
}

async function render() {
  document.documentElement.lang = DEFAULT_LOCALE;
  const route = getCurrentRoute();

  // Update SEO for the current route
  const settings = getPublicSettings();
  const seo = getSeoForRoute(route, { site_name: settings.site_name, site_slogan: settings.site_slogan });
  updateSeo(seo);

  if (route === '/about') {
    mountAboutPage(app!, bindNavigation);
    return;
  }

  if (route === '/propose') {
    const canonicalRoute = route.replace(/^\/propose/, '/submit');
    window.history.replaceState({}, '', canonicalRoute);
    await render();
    return;
  }

  if (route === '/submit') {
    mountProposePage(app!, bindNavigation);
    return;
  }

  if (route === '/login') {
    await mountLoginPage(app!, bindNavigation);
    return;
  }

  if (route === '/register') {
    await mountRegisterPage(app!, bindNavigation);
    return;
  }

  if (route === '/reset') {
    mountResetPage(app!, bindNavigation);
    return;
  }

  if (route === '/account' || route.startsWith('/account/')) {
    // Each dashboard section has its own route; an unknown one falls back to the
    // account section and the URL is corrected.
    const section = accountSectionFromRoute(route);
    const canonical = ACCOUNT_SECTIONS.find((entry) => entry.section === section)!.route;
    if (canonical !== route) window.history.replaceState({}, '', canonical);
    await mountAccountPage(app!, bindNavigation, navigateTo, section);
    return;
  }

  if (route === '/polls') {
    await mountHome(app!, getQueryPage('page'), bindNavigation, getPublicSettings());
    return;
  }

  if (route.startsWith('/topic/')) {
    const topicSlug = route.split('/').pop() ?? '';
    await mountHome(app!, getQueryPage('page'), bindNavigation, getPublicSettings(), topicSlug);
    return;
  }

  if (route.startsWith('/vote/')) {
    const legacyRoute = route.replace(/^\/vote\//, '/poll/');
    window.history.replaceState({}, '', legacyRoute);
    await render();
    return;
  }

  if (route.startsWith('/poll/')) {
    const pollId = Number(route.split('/').pop() ?? '0');
    await mountVotePage(Number.isSafeInteger(pollId) && pollId > 0 ? pollId : 0, app!, bindNavigation);
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
    document.documentElement.lang = DEFAULT_LOCALE;
    document.documentElement.style.setProperty('--page-width', `${getPublicSettings().page_max_width_px}px`);
    applyFavicon();
    await loadTranslations(DEFAULT_LOCALE);
    await loadSession();
    setSearchNavigator(navigateTo);
    bindHeaderSearch();
    await render();
  } catch (error) {
    app.setAttribute('role', 'alert');
    app.textContent = `Could not load application settings or translations: ${getErrorMessage(error)}`;
  }
}

void start();
