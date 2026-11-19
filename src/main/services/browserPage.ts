import { truncateEnd } from '../util'

/** Tags every visible interactive element with a ref and returns an outline the model can act on. */
export const SNAPSHOT_SCRIPT = `(() => {
  const MAX = 220;
  const sel = 'a[href],button,input,textarea,select,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],[role=switch],[role=option],[role=combobox],[role=textbox],[contenteditable=""],[contenteditable=true],[onclick],[tabindex]:not([tabindex="-1"])';
  document.querySelectorAll('[data-gx-ref]').forEach((el) => el.removeAttribute('data-gx-ref'));
  const clean = (s, n) => (s || '').replace(/\\s+/g, ' ').trim().slice(0, n);
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
  };
  const lines = [];
  let n = 0;
  for (const el of document.querySelectorAll(sel)) {
    if (n >= MAX) break;
    if (!visible(el) || el.disabled) continue;
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'input' ? (el.type || 'text') : tag === 'select' ? 'select' : tag === 'textarea' ? 'textarea' : tag === 'summary' ? 'summary' : 'button');
    const name = clean(el.getAttribute('aria-label') || el.innerText || (el.type === 'password' ? '' : el.value) || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('name'), 90);
    if (!name && !['text','search','email','password','textarea','select','number','tel','url','checkbox','radio'].includes(role)) continue;
    n += 1;
    el.setAttribute('data-gx-ref', String(n));
    let line = '[' + n + '] ' + role + (name ? ' "' + name + '"' : '');
    if (tag === 'a') { try { const u = new URL(el.href); line += ' -> ' + (u.origin === location.origin ? u.pathname + u.search : u.href).slice(0, 100); } catch {} }
    if ((tag === 'input' || tag === 'textarea') && el.value && el.type !== 'password') line += ' value="' + clean(el.value, 60) + '"';
    if (role === 'checkbox' || role === 'radio' || role === 'switch') line += el.checked || el.getAttribute('aria-checked') === 'true' ? ' (checked)' : ' (unchecked)';
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) line += ' (offscreen)';
    lines.push(line);
  }
  return {
    url: location.href,
    title: document.title,
    scroll: Math.round(scrollY) + '/' + Math.max(0, Math.round(document.documentElement.scrollHeight - innerHeight)),
    elements: lines,
    text: (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').trim()
  };
})()`

export function locateScript(target: { ref?: number; selector?: string }): string {
  const find =
    target.ref !== undefined
      ? `document.querySelector('[data-gx-ref="${Number(target.ref)}"]')`
      : `document.querySelector(${JSON.stringify(target.selector ?? '')})`
  return `(() => {
    const el = ${find};
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
    const hit = document.elementFromPoint(x, y);
    return { x, y, hit: !!hit && (hit === el || el.contains(hit) || hit.contains(el)), tag: el.tagName.toLowerCase() };
  })()`
}

export interface PageSnapshot {
  url: string
  title: string
  scroll: string
  elements: string[]
  text: string
}

export function formatPageSnapshot(snap: PageSnapshot, includeText: boolean): string {
  const parts = [`URL: ${snap.url}`, `Title: ${snap.title}`, `Scroll: ${snap.scroll}`]
  parts.push('', snap.elements.length ? `Interactive elements:\n${snap.elements.join('\n')}` : 'No interactive elements found.')
  if (includeText) parts.push('', `Page text:\n${truncateEnd(snap.text, 12000)}`)
  return parts.join('\n')
}

export function keyEvent(key: string) {
  const parts = key.split('+').map((p) => p.trim())
  const raw = parts.pop() ?? ''
  const aliases: Record<string, string> = { Return: 'Enter', Esc: 'Escape', Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight', Space: ' ' }
  const keyCode = aliases[raw] ?? raw
  const masks: Record<string, number> = { alt: 1, option: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, shift: 8 }
  const modifiers = parts.reduce((mask, modifier) => mask | (masks[modifier.toLowerCase()] ?? 0), 0)
  const virtualKeys: Record<string, number> = { Backspace: 8, Tab: 9, Enter: 13, Escape: 27, ' ': 32, PageUp: 33, PageDown: 34, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46 }
  const virtualKey = virtualKeys[keyCode] ?? (/^F\d{1,2}$/.test(keyCode) ? 111 + Number(keyCode.slice(1)) : keyCode.length === 1 ? keyCode.toUpperCase().charCodeAt(0) : undefined)
  const text = !(modifiers & (1 | 2 | 4)) ? keyCode === 'Enter' ? '\r' : keyCode.length === 1 ? keyCode : undefined : undefined
  const params = { key: keyCode, modifiers, windowsVirtualKeyCode: virtualKey }
  return { params, text }
}
