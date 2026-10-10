import { getPoll } from './lib/poll';
import { getErrorMessage, t } from './ui';

let navigateTo: ((route: string) => void) | null = null;

export function setSearchNavigator(navigate: (route: string) => void): void {
  navigateTo = navigate;
}

function searchRoot(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-search-root]');
}

function searchForm(): HTMLFormElement | null {
  return document.querySelector<HTMLFormElement>('[data-search-form]');
}

function searchStatus(message: string): void {
  const status = document.querySelector<HTMLElement>('[data-search-status]');
  if (!status) return;
  status.textContent = message;
  status.hidden = message === '';
}

function openSearch(): void {
  const root = searchRoot();
  const form = searchForm();
  const input = document.querySelector<HTMLInputElement>('[data-search-input]');
  const toggle = document.querySelector<HTMLButtonElement>('[data-search-toggle]');
  if (!root || !form || !input) return;

  root.dataset.searchOpen = 'true';
  form.classList.remove('w-0', 'opacity-0', 'pointer-events-none');
  form.classList.add('w-56', 'opacity-100', 'max-[700px]:w-full');
  toggle?.classList.remove('w-9', 'opacity-100');
  toggle?.classList.add('w-0', 'overflow-hidden', 'border-0', 'opacity-0', 'pointer-events-none');
  toggle?.setAttribute('aria-expanded', 'true');
  searchStatus('');
  input.focus();
}

function closeSearch(): void {
  const root = searchRoot();
  const form = searchForm();
  const input = document.querySelector<HTMLInputElement>('[data-search-input]');
  const toggle = document.querySelector<HTMLButtonElement>('[data-search-toggle]');
  if (!root || !form) return;

  root.dataset.searchOpen = 'false';
  form.classList.add('w-0', 'opacity-0', 'pointer-events-none');
  form.classList.remove('w-56', 'opacity-100', 'max-[700px]:w-full');
  toggle?.classList.add('w-9', 'opacity-100');
  toggle?.classList.remove('w-0', 'overflow-hidden', 'border-0', 'opacity-0', 'pointer-events-none');
  toggle?.setAttribute('aria-expanded', 'false');
  searchStatus('');
  if (input) input.value = '';
}

async function submitSearch(rawValue: string): Promise<void> {
  const value = rawValue.trim();
  if (!value || !navigateTo) return;

  // A pure number is treated as a poll ID: jump straight to that poll when it exists.
  if (/^\d+$/.test(value)) {
    try {
      const poll = await getPoll(Number(value));
      navigateTo(`/poll/${poll.id}`);
      return;
    } catch (error) {
      const message = getErrorMessage(error);
      searchStatus(message.includes('(404)') ? t('searchPollNotFound') : message);
      return;
    }
  }

  navigateTo(`/?q=${encodeURIComponent(value)}`);
}

export function bindHeaderSearch(): void {
  document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;

    if (target.closest('[data-search-toggle]')) {
      event.preventDefault();
      const isOpen = searchRoot()?.dataset.searchOpen === 'true';
      if (isOpen) closeSearch();
      else openSearch();
      return;
    }

    if (target.closest('[data-search-close]')) {
      event.preventDefault();
      closeSearch();
    }
  });

  document.addEventListener('submit', (event) => {
    const form = event.target as HTMLElement | null;
    if (!form || !form.matches('[data-search-form]')) return;
    event.preventDefault();
    const input = form.querySelector<HTMLInputElement>('[data-search-input]');
    void submitSearch(input?.value ?? '');
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (searchRoot()?.dataset.searchOpen !== 'true') return;
    closeSearch();
  });
}
