// Scene 1: big title (white + yellow line), typewriter subtitle. Pure function of ctx.time.
TNF.scenes.push(TNF.scene({
  id: 'intro', start: 0, end: 3, enter: 'glitch', exit: { type: 'slide', dur: 0.5, dir: 'up' },
  mount(c) {
    const a = c.area, b = c.brand;
    const h1 = TNF.el('div', { text: 'GIẢI PHÁP', style: { position: 'absolute', left: a.x + 'px', top: (a.y + 260) + 'px', font: '900 150px/1.05 var(--f-heading)', color: 'var(--c-text)' } });
    const h2 = TNF.el('div', { text: 'THANG MÁY', style: { position: 'absolute', left: a.x + 'px', top: (a.y + 430) + 'px', font: '900 150px/1.05 var(--f-heading)', color: 'var(--c-accent)' } });
    const sub = TNF.el('div', { style: { position: 'absolute', left: a.x + 'px', top: (a.y + 700) + 'px', width: a.w + 'px', font: '600 52px/1.3 var(--f-body)', color: 'var(--c-text)' } });
    const bar = TNF.el('div', { style: { position: 'absolute', left: a.x + 'px', top: (a.y + 640) + 'px', height: '8px', width: '0px', background: 'var(--c-accent)', borderRadius: '4px' } });
    c.root.append(h1, h2, bar, sub);
    TNF.fit(h1, a.w, 170, { nowrap: true, max: 150 });
    TNF.fit(h2, a.w, 170, { nowrap: true, max: 150 });
    Object.assign(c.state, { h1, h2, sub, bar, text: b.tagline || 'Giải pháp đáng tin cậy' });
  },
  render(c) {
    const s = c.state;
    s.h1.style.opacity = TNF.tween(c.time, 0, 1, 0.1, 0.6, 'outCubic');
    s.h1.style.translate = '0px ' + TNF.tween(c.time, 60, 0, 0.1, 0.6, 'outBack') + 'px';
    s.h2.style.opacity = TNF.tween(c.time, 0, 1, 0.4, 0.9, 'outCubic');
    s.h2.style.translate = '0px ' + TNF.tween(c.time, 60, 0, 0.4, 0.9, 'outBack') + 'px';
    s.bar.style.width = TNF.tween(c.time, 0, 360, 0.8, 1.4, 'inOutCubic') + 'px';
    s.sub.textContent = TNF.typewriter(s.text + ' - tư vấn, lắp đặt, bảo trì', c.time, 1.2, 24, { cursor: '|' });
  },
}));
