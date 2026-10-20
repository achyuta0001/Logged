// "Add to Home Screen" hint for phones. Once the reader has opened a pincode or the Commute tab twice
// (counted across visits in localStorage), a quiet card offers the app for the home screen: Chrome on
// Android gets an Install button (its own install prompt, held back from `beforeinstallprompt`), iOS
// gets the Share, Add to Home Screen steps. Never shown in the installed app, with a mouse, or again
// once dismissed or installed; without localStorage it never shows.
import { iconSvg } from './icons';

const OPENS = 'logged:install-opens';
const DONE = 'logged:install-hint';

interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: InstallPrompt | null = null;
let timer = 0;

function read(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function write(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* storage blocked: nothing to count, so the hint stays away */
  }
}

const standalone = () => matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
const ios = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const wanted = () => !read(DONE) && !standalone() && matchMedia('(pointer: coarse)').matches;

/** iOS share glyph: a tray with an arrow out of it (drawn here, no system symbol font) */
const SHARE = '<svg class="ih-share" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 14V3.5M8.5 7 12 3.5 15.5 7"/><path d="M8 10H6.5v10h11V10H16"/></svg>';

function finish(how: string) {
  write(DONE, how);
  clearTimeout(timer);
  document.getElementById('install-hint')?.remove();
}

/** Call once at startup: keeps Chrome's install prompt for the hint's button and notes an install. */
export function initInstallHint(): void {
  window.addEventListener('beforeinstallprompt', (e) => {
    if (!wanted()) return; // leave the browser's own install UI alone
    e.preventDefault();
    deferred = e as InstallPrompt;
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    finish('installed');
  });
}

/** A pincode or the Commute tab finished opening: from the second time on, show the hint. */
export function noteOpen(): void {
  if (!wanted()) return;
  write(OPENS, String((Number(read(OPENS)) || 0) + 1));
  if (!(Number(read(OPENS)) >= 2)) return; // read back, so blocked storage never counts up
  clearTimeout(timer);
  timer = window.setTimeout(show, 1500); // once the view has settled
}

function show() {
  if (document.getElementById('install-hint') || !wanted()) return;
  const apple = ios();
  if (!apple && !deferred) return; // this browser offers no install from here
  const el = document.createElement('div');
  el.id = 'install-hint';
  el.className = 'glass install-hint';
  el.setAttribute('role', 'status');
  el.innerHTML = `<p><b>Add to Home Screen</b> for quick checks before you leave${apple ? `<span class="ih-how">Tap Share ${SHARE} then Add to Home Screen</span>` : ''}</p>
    ${apple ? '' : '<button type="button" class="btn primary ih-install">Install</button>'}
    <button type="button" class="ih-close" aria-label="Dismiss">${iconSvg('close', 14, 2)}</button>`;
  el.querySelector('.ih-close')!.addEventListener('click', () => finish('dismissed'));
  el.querySelector('.ih-install')?.addEventListener('click', async () => {
    const p = deferred;
    deferred = null;
    if (!p) return finish('dismissed');
    try {
      await p.prompt();
      finish((await p.userChoice).outcome === 'accepted' ? 'installed' : 'dismissed');
    } catch {
      finish('dismissed');
    }
  });
  document.body.append(el);
}
