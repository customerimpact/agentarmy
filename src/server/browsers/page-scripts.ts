// JavaScript evaluated inside the page (Runtime.evaluate). Kept as plain strings so bundling
// can never rewrite them.

// Links and window.open() stay in the same tab: a tile shows exactly one page
export const SAME_TAB_SCRIPT = `
(() => {
  document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a[target]') : null;
    if (a && a.target !== '_self') a.target = '_self';
  }, true);
  const open = window.open;
  window.open = function (url, target, features) {
    if (url) { location.href = String(url); return window; }
    return open.call(window, url, target, features);
  };
})();
`;

// Finds an element by CSS selector or by visible text, scrolls it into view and returns the
// center of its box in viewport (CSS) pixels.
export function locateScript(selector: string | null, text: string | null): string {
  return `
(() => {
  const selector = ${JSON.stringify(selector)};
  const wanted = ${JSON.stringify(text)};
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  };
  const label = (el) => {
    const t = (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || '').trim();
    return el.tagName.toLowerCase() + (t ? ' "' + t.replace(/\\s+/g, ' ').slice(0, 60) + '"' : '');
  };
  let el = null;
  if (selector) {
    try { el = document.querySelector(selector); } catch (e) { return { error: 'Invalid selector: ' + selector }; }
    if (!el) return { error: 'No element matches ' + selector };
  } else if (wanted) {
    const needle = wanted.trim().toLowerCase().replace(/\\s+/g, ' ');
    const interactive = 'a,button,input,select,textarea,summary,label,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=option],[onclick],[tabindex]';
    let best = null, bestScore = -1;
    for (const node of document.querySelectorAll('body *')) {
      if (!visible(node)) continue;
      const own = (node.getAttribute('aria-label') || node.innerText || node.value || node.getAttribute('placeholder') || node.getAttribute('title') || node.getAttribute('alt') || '').trim().toLowerCase().replace(/\\s+/g, ' ');
      if (!own || !own.includes(needle)) continue;
      let score = own === needle ? 1000 : 500 - Math.min(400, own.length - needle.length);
      if (node.matches(interactive)) score += 300;
      else if (node.closest(interactive)) score += 150;
      // Prefer the innermost element: area as a tie breaker
      const r = node.getBoundingClientRect();
      score -= Math.min(100, (r.width * r.height) / 20000);
      if (score > bestScore) { best = node; bestScore = score; }
    }
    if (!best) return { error: 'No visible element contains the text "' + wanted + '"' };
    el = best.closest('a,button,[role=button],[role=link],label,summary') || best;
  } else return { error: 'Give a selector, a text, or x and y' };
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), label: label(el) };
})()
`;
}

// Visible text plus a list of interactive elements the agent can click or type into
export const READ_SCRIPT = `
(() => {
  const text = (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n');
  const items = [];
  const seen = new Set();
  const cssEscape = (v) => (window.CSS && CSS.escape ? CSS.escape(v) : v);
  for (const el of document.querySelectorAll('a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[contenteditable=true]')) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none') continue;
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'input' ? 'input:' + (el.type || 'text') : tag);
    const name = (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    let selector = '';
    if (el.id) selector = '#' + cssEscape(el.id);
    else if (el.getAttribute('name')) selector = tag + '[name="' + el.getAttribute('name') + '"]';
    else if (el.getAttribute('aria-label')) selector = tag + '[aria-label="' + el.getAttribute('aria-label').replace(/"/g, '\\\\"') + '"]';
    const key = role + '|' + name + '|' + selector;
    if (seen.has(key) || (!name && !selector)) continue;
    seen.add(key);
    const inView = r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
    items.push({ role, name, selector, inView });
    if (items.length >= 80) break;
  }
  return { url: location.href, title: document.title, text, items, scrollY: Math.round(scrollY), scrollHeight: document.documentElement.scrollHeight, viewportHeight: innerHeight };
})()
`;
