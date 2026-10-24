export interface CursorUpdate {
  action: 'center' | 'move' | 'click' | 'show' | 'hide'
  x?: number
  y?: number
}

// Runs in an isolated world inside the native browser view, above page content.
// A renderer overlay would sit behind WebContentsView and would not be visible.
export function agentCursorScript(update: CursorUpdate): string {
  return `(() => {
    const update = ${JSON.stringify(update)};
    const key = '__galaxyAgentCursor';
    const size = 30;
    const hotspot = 4.21875;
    if (update.action === 'hide') {
      globalThis[key]?.hide();
      return 0;
    }
    if (!globalThis[key] || !globalThis[key].host.isConnected) {
      const host = document.createElement('div');
      host.setAttribute('aria-hidden', 'true');
      host.setAttribute('inert', '');
      for (const [name, value] of Object.entries({
        all: 'initial', position: 'fixed', inset: '0', width: '100%', height: '100%',
        margin: '0', padding: '0', border: '0', background: 'transparent',
        overflow: 'visible', 'pointer-events': 'none', 'z-index': '2147483647'
      })) host.style.setProperty(name, value, 'important');
      const shadow = host.attachShadow({ mode: 'closed' });
      const node = (styles) => {
        const el = document.createElement('div');
        Object.assign(el.style, { position: 'absolute', pointerEvents: 'none', ...styles });
        shadow.append(el);
        return el;
      };
      const cursor = node({ left: '0', top: '0', width: size + 'px', height: size + 'px', opacity: '0', transition: 'opacity 180ms ease', willChange: 'transform', zIndex: '2' });
      const glyph = document.createElement('div');
      Object.assign(glyph.style, { width: size + 'px', height: size + 'px', transformOrigin: hotspot + 'px ' + hotspot + 'px', pointerEvents: 'none' });
      cursor.append(glyph);
      const svgNode = (tag, attrs) => {
        const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
        for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
        return el;
      };
      const svg = svgNode('svg', { width: String(size), height: String(size), viewBox: '0 0 32 32', fill: 'none' });
      svg.style.overflow = 'visible';
      const defs = svgNode('defs', {});
      const filter = svgNode('filter', { id: 'blue-glow', x: '-80%', y: '-80%', width: '260%', height: '260%' });
      filter.append(svgNode('feGaussianBlur', { stdDeviation: '2.2' }));
      defs.append(filter);
      svg.append(defs);
      const d = 'M6.8 4.5 C5.2 3.9 4.1 5.1 4.7 6.8 L10.6 22 C11.1 23.3 12.5 23.2 13 21.9 L15.1 16.6 C15.4 15.9 15.9 15.4 16.6 15.1 L21.9 13 C23.2 12.5 23.3 11.1 22 10.6 Z';
      svg.append(svgNode('path', { d, fill: 'none', stroke: '#258BFF', 'stroke-opacity': '.3', 'stroke-width': '4.2', 'stroke-linejoin': 'round', filter: 'url(#blue-glow)' }));
      svg.append(svgNode('path', { d, fill: '#050505', stroke: '#FFFFFF', 'stroke-width': '1.6', 'stroke-linejoin': 'round' }));
      glyph.append(svg);
      document.documentElement.append(host);
      // The top layer keeps the cursor above site dialogs without taking focus.
      try { host.setAttribute('popover', 'manual'); host.showPopover(); } catch { host.removeAttribute('popover'); }
      let position = { x: innerWidth / 2, y: innerHeight / 2 };
      let waitingAtCenter = true;
      let motion = null;
      let press = null;
      const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
      const transform = (point) => 'translate3d(' + (point.x - hotspot) + 'px,' + (point.y - hotspot) + 'px,0)';
      cursor.style.transform = transform(position);
      addEventListener('resize', () => {
        if (!waitingAtCenter || !host.isConnected) return;
        position = { x: innerWidth / 2, y: innerHeight / 2 };
        cursor.style.transform = transform(position);
      });
      globalThis[key] = {
        host,
        hide() { cursor.style.opacity = '0'; },
        center() { return this.move(innerWidth / 2, innerHeight / 2, false, true); },
        move(x, y, animate = true, keepCentered = false) {
          waitingAtCenter = keepCentered;
          let from = position;
          if (motion && motion.playState === 'running') {
            const matrix = new DOMMatrixReadOnly(getComputedStyle(cursor).transform);
            from = { x: matrix.m41 + hotspot, y: matrix.m42 + hotspot };
          }
          motion?.cancel();
          position = { x, y };
          cursor.style.opacity = '1';
          cursor.style.transform = transform(position);
          const distance = Math.hypot(x - from.x, y - from.y);
          const duration = !animate || reduced() || distance < 2 ? 0 : Math.min(360, 160 + distance * 0.22);
          if (duration) motion = cursor.animate([{ transform: transform(from) }, { transform: transform(position) }], { duration, easing: 'cubic-bezier(.22,1,.36,1)' });
          return duration;
        },
        click(x, y) {
          this.move(x, y, false);
          press?.cancel();
          if (!reduced()) press = glyph.animate([{ transform: 'scale(1)' }, { transform: 'scale(.9)', offset: .35 }, { transform: 'scale(1)' }], { duration: 200, easing: 'cubic-bezier(.2,.8,.2,1)' });
        }
      };
    }
    const api = globalThis[key];
    if (update.action === 'center') return api.center();
    if (update.action === 'click') { api.click(update.x, update.y); return 0; }
    return api.move(update.x, update.y, update.action === 'move');
  })()`
}
