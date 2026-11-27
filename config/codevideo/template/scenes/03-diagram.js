// Scene 3: isometric block diagram, boxes grow, dotted connectors run.
TNF.scenes.push(TNF.scene({
  id: 'diagram', start: 6, end: 9, enter: { type: 'slide', dir: 'left', dur: 0.5 }, exit: 'fade',
  mount(c) {
    const a = c.area;
    const cap = TNF.el('div', { text: 'SƠ ĐỒ HỆ THỐNG', style: { position: 'absolute', left: a.x + 'px', top: (a.y + 20) + 'px', width: a.w + 'px', textAlign: 'center', font: '900 72px/1.1 var(--f-heading)', color: 'var(--c-text)' } });
    const host = TNF.el('div', { style: { position: 'absolute', left: '0px', top: '0px', width: c.w + 'px', height: c.h + 'px' } });
    c.root.append(cap, host);
    c.state.host = host;
  },
  render(c) {
    const a = c.area, br = c.brand.colors;
    const view = { ox: c.w / 2, oy: a.y + 640, s: 1.05 };
    const g = (t0) => TNF.tween(c.time, 0, 1, t0, t0 + 0.7, 'outBack');
    const blocks = [
      { x: -200, y: -200, w: 120, d: 120, h: 140, color: br.primary, t0: 0.1, floors: 4 },
      { x: 120, y: -200, w: 120, d: 120, h: 220, color: br.accent, t0: 0.3, floors: 7 },
      { x: -200, y: 120, w: 120, d: 120, h: 100, color: '#2bd4a0', t0: 0.5, floors: 3 },
      { x: 120, y: 120, w: 120, d: 120, h: 170, color: '#ff5a7a', t0: 0.7, floors: 5 },
    ];
    const core = [[-140, -140, 0], [180, -140, 0], [180, 180, 0], [-140, 180, 0]];
    const link = (p, q, t0) => TNF.iso.connector([p, q], { view, t: c.time, progress: TNF.tween(c.time, 0, 1, t0, t0 + 0.8, 'inOutCubic'), color: br.accent });
    let s = link(core[0], core[1], 0.9) + link(core[1], core[2], 1.1) + link(core[3], core[2], 1.3) + link(core[0], core[3], 1.5);
    blocks.forEach((b) => { s += TNF.iso.building(Object.assign({ view, grow: g(b.t0) }, b)); });
    s += TNF.iso.box({ x: -60, y: -60, w: 120, d: 120, h: 40, color: '#ffffff', view, grow: g(0), opacity: 0.9 });
    c.state.host.innerHTML = TNF.iso.wrap(c.w, c.h, s);
  },
}));
