// Scene 4: logo card, hotline card with phone icon, round pedestal with a placeholder cabin.
// To use real footage instead: add <video src="assets/cabin-turntable.mp4"> in mount(), then
//   const v = TNF.video(videoEl, { start: 9, loop: true });   and in render():  return v.seek(c.t);
TNF.scenes.push(TNF.scene({
  id: 'outro', start: 9, end: 12, enter: 'glitch', exit: 'none',
  mount(c) {
    const a = c.area, b = c.brand;
    const logoCard = TNF.card({ x: a.x + 60, y: a.y + 40, w: a.w - 120, h: 190, bg: '#ffffff', radius: 44, children: [TNF.logo(b, 120)] });
    logoCard.style.display = 'flex'; logoCard.style.alignItems = 'center'; logoCard.style.justifyContent = 'center';
    const ph = TNF.el('div', { html: TNF.icon('phone', { size: 90, color: '#06174a', stroke: 2.2 }) });
    const num = TNF.el('div', { text: b.hotline || '0900 000 000', style: { font: '900 84px/1 var(--f-heading)', color: '#06174a', whiteSpace: 'nowrap' } });
    const hot = TNF.card({ x: a.x + 60, y: a.y + 290, w: a.w - 120, h: 170, bg: b.colors.accent, border: 'none', radius: 44, children: [ph, num] });
    hot.style.display = 'flex'; hot.style.alignItems = 'center'; hot.style.justifyContent = 'center'; hot.style.gap = '26px';
    const host = TNF.el('div', { style: { position: 'absolute', left: '0px', top: '0px', width: c.w + 'px', height: c.h + 'px' } });
    c.root.append(host, logoCard, hot);
    Object.assign(c.state, { host, logoCard, hot });
  },
  render(c) {
    const a = c.area, br = c.brand.colors, cx = c.w / 2, cy = a.y + 1050, s = c.state;
    s.logoCard.style.scale = TNF.tween(c.time, 0.8, 1, 0.1, 0.7, 'outBack');
    s.hot.style.scale = TNF.tween(c.time, 0.8, 1, 0.3, 0.9, 'outBack') * (1 + 0.02 * TNF.pulse(c.time, 1.2));
    const w = 150 + 60 * Math.abs(Math.cos(c.time * 1.2)); // placeholder cabin squeezes as it "rotates"
    const ped = '<ellipse cx="' + cx + '" cy="' + (cy + 60) + '" rx="300" ry="90" fill="' + TNF.color.rgba(br.primary, 0.5) + '" stroke="' + br.accent + '" stroke-width="5"/>' +
      '<ellipse cx="' + cx + '" cy="' + (cy + 30) + '" rx="270" ry="76" fill="#0b2a7a" stroke="' + TNF.color.rgba('#ffffff', 0.5) + '" stroke-width="2"/>';
    const cab = '<rect x="' + (cx - w) + '" y="' + (cy - 380) + '" width="' + (w * 2) + '" height="420" rx="14" fill="' + TNF.color.rgba('#ffffff', 0.85) + '"/>' +
      '<rect x="' + (cx - w + 22) + '" y="' + (cy - 358) + '" width="' + (w * 2 - 44) + '" height="376" rx="8" fill="' + br.primary + '"/>';
    s.host.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="' + c.w + '" height="' + c.h + '">' + ped + cab + '</svg>';
  },
}));
