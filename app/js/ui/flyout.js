// Photoshop-style tool groups: one button shows the current choice; hovering (or long-pressing,
// right-clicking, or clicking the little corner triangle) opens a flyout with every variant.
//
//   group = { id, title, items:[{ id, icon, label, key?, on? }], current: itemId, active?: bool,
//             onPick(item), onMain?(item), showLabel?: bool }
//   groupHTML(group, variant)  → markup ('bar' | 'rail' | 'tile')
//   bindGroups(root, groups, { placement })  → wires events (placement: 'below' | 'right')

let openFly = null;      // { panel, anchor, gid, hideT }
const HOVER_OPEN_MS = 160, HOVER_CLOSE_MS = 240, LONG_PRESS_MS = 420;

export function closeFlyout() {
  if (!openFly) return;
  clearTimeout(openFly.hideT);
  openFly.panel.remove();
  openFly.anchor?.classList.remove('fly-open');
  openFly = null;
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function groupHTML(g, variant = 'bar') {
  const cur = g.items.find(it => it.id === g.current) || g.items[0];
  const many = g.items.length > 1;
  const title = `${g.title}${cur && many ? ` — ${cur.label}` : ''}${cur?.key ? ` (${cur.key})` : ''}${many ? ' · 마우스를 올리면 종류 선택' : ''}`;
  const label = variant === 'tile' || g.showLabel ? `<span class="fly-label"><b>${esc(g.title)}</b>${many ? `<small>${esc(cur?.label || '')}</small>` : g.sub ? `<small>${esc(g.sub)}</small>` : ''}</span>` : '';
  return `<div class="fly fly-${variant}" data-fly="${g.id}"><button class="fly-main ${g.active ? 'on' : ''}" data-fly-main="${g.id}" title="${esc(title)}" aria-haspopup="${many}">${cur?.icon || ''}${label}${many ? '<span class="fly-tri" aria-hidden="true"></span>' : ''}</button></div>`;
}

export function bindGroups(root, groups, { placement = 'below' } = {}) {
  const byId = new Map(groups.map(g => [g.id, g]));
  root.querySelectorAll('.fly[data-fly]').forEach(wrap => {
    const g = byId.get(wrap.dataset.fly); if (!g) return;
    const btn = wrap.querySelector('.fly-main');
    const many = g.items.length > 1;
    let pressT = null, longOpened = false, enterT = null;
    const show = () => { if (many) openPanel(g, btn, placement); };
    btn.addEventListener('click', (e) => {
      if (longOpened) { longOpened = false; e.preventDefault(); return; }
      if (many && e.target.closest('.fly-tri')) { e.stopPropagation(); show(); return; }
      closeFlyout();
      const cur = g.items.find(it => it.id === g.current) || g.items[0];
      (g.onMain || g.onPick)?.(cur);
    });
    btn.addEventListener('contextmenu', (e) => { if (!many) return; e.preventDefault(); show(); });
    btn.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' || !many) return;
      longOpened = false;
      pressT = setTimeout(() => { longOpened = true; if (navigator.vibrate) navigator.vibrate(8); show(); }, LONG_PRESS_MS);
    });
    const cancelPress = () => { clearTimeout(pressT); pressT = null; };
    btn.addEventListener('pointerup', cancelPress); btn.addEventListener('pointercancel', cancelPress); btn.addEventListener('pointerleave', cancelPress);
    if (many) {
      wrap.addEventListener('mouseenter', () => {
        if (openFly && openFly.gid === g.id) { clearTimeout(openFly.hideT); return; }
        clearTimeout(enterT);
        enterT = setTimeout(show, openFly ? 0 : HOVER_OPEN_MS);   // moving along a bar with one open → switch instantly
      });
      wrap.addEventListener('mouseleave', () => { clearTimeout(enterT); scheduleHide(); });
    }
  });
}

function scheduleHide() {
  if (!openFly) return;
  clearTimeout(openFly.hideT);
  const ref = openFly;
  ref.hideT = setTimeout(() => { if (openFly === ref && !ref.panel.matches(':hover') && !ref.anchor.matches(':hover')) closeFlyout(); }, HOVER_CLOSE_MS);
}

function openPanel(g, anchor, placement) {
  if (openFly && openFly.gid === g.id) return;
  closeFlyout();
  const panel = document.createElement('div');
  panel.className = 'fly-panel glass';
  panel.setAttribute('role', 'menu');
  panel.innerHTML = `<div class="fly-head">${esc(g.title)}</div>` + g.items.map((it, i) => `<button role="menuitem" class="fly-item ${it.id === g.current ? 'cur' : ''} ${it.on ? 'on' : ''}" data-i="${i}">${it.icon || ''}<span class="fly-name">${esc(it.label)}</span>${it.key ? `<kbd>${esc(it.key)}</kbd>` : ''}</button>`).join('');
  (document.getElementById('layer') || document.body).appendChild(panel);
  const r = anchor.getBoundingClientRect();
  const pw = panel.offsetWidth, ph = panel.offsetHeight;
  let x, y;
  if (placement === 'right') { x = r.right + 8; y = r.top - 6; }
  else if (placement === 'above') { x = r.left; y = r.top - ph - 6; }
  else { x = r.left; y = r.bottom + 6; }
  x = Math.max(8, Math.min(window.innerWidth - pw - 8, x));
  y = Math.max(8, Math.min(window.innerHeight - ph - 8, y));
  panel.style.left = x + 'px'; panel.style.top = y + 'px';
  anchor.classList.add('fly-open');
  openFly = { panel, anchor, gid: g.id, hideT: null };
  panel.addEventListener('mouseenter', () => { if (openFly?.panel === panel) clearTimeout(openFly.hideT); });
  panel.addEventListener('mouseleave', scheduleHide);
  panel.querySelectorAll('.fly-item').forEach(b => b.addEventListener('click', () => {
    const it = g.items[+b.dataset.i];
    closeFlyout();
    g.onPick?.(it);
  }));
}

// global dismissal
if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', (e) => { if (openFly && !openFly.panel.contains(e.target) && !openFly.anchor.contains(e.target)) closeFlyout(); }, true);
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeFlyout(); }, true);
  window.addEventListener('blur', closeFlyout);
  window.addEventListener('resize', closeFlyout);
}
