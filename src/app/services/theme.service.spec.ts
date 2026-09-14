import { ThemeService } from './theme.service';

describe('ThemeService light-only mode', () => {
  const storageKey = 'app-theme-mode';
  let savedTheme: string | null;
  let savedBodyClass: string;
  let savedDataTheme: string | null;
  let savedColorScheme: string;

  beforeEach(() => {
    savedTheme = localStorage.getItem(storageKey);
    savedBodyClass = document.body.className;
    savedDataTheme = document.documentElement.getAttribute('data-theme');
    savedColorScheme = document.documentElement.style.colorScheme;
  });

  afterEach(() => {
    savedTheme == null
      ? localStorage.removeItem(storageKey)
      : localStorage.setItem(storageKey, savedTheme);
    document.body.className = savedBodyClass;
    savedDataTheme == null
      ? document.documentElement.removeAttribute('data-theme')
      : document.documentElement.setAttribute('data-theme', savedDataTheme);
    document.documentElement.style.colorScheme = savedColorScheme;
  });

  it('removes a previously saved dark preference and forces light rendering', () => {
    localStorage.setItem(storageKey, 'dark');
    document.body.classList.add('dark', 'dark-theme');
    document.documentElement.setAttribute('data-theme', 'dark');

    new ThemeService();

    expect(localStorage.getItem(storageKey)).toBeNull();
    expect(document.body.classList.contains('dark')).toBeFalse();
    expect(document.body.classList.contains('dark-theme')).toBeFalse();
    expect(document.body.classList.contains('light')).toBeTrue();
    expect(document.documentElement.hasAttribute('data-theme')).toBeFalse();
    expect(document.documentElement.style.colorScheme).toBe('light');
  });
});
