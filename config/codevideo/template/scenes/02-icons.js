// Scene 2: 2x4 icon grid; each cell enters with RGB glitch.
TNF.scenes.push(TNF.scene({
  id: 'icons', start: 3, end: 6, enter: 'glitch', exit: 'fade',
  mount(c) {
    const a = c.area;
    const title = TNF.el('div', { text: 'VÌ SAO CHỌN CHÚNG TÔI', style: { position: 'absolute', left: a.x + 'px', top: (a.y + 20) + 'px', fontWeight: '900', fontFamily: 'var(--f-heading)', color: 'var(--c-accent)', textAlign: 'center' } });
    c.root.append(title);
    TNF.fit(title, a.w, 90, { nowrap: true, max: 72 });
    const items = [
      { icon: 'shield', label: 'An toàn' }, { icon: 'bolt', label: 'Tiết kiệm điện' },
      { icon: 'wrench', label: 'Bảo trì nhanh' }, { icon: 'building', label: 'Mọi công trình' },
      { icon: 'elevator', label: 'Thang đa dạng' }, { icon: 'gear', label: 'Linh kiện chuẩn' },
      { icon: 'user', label: 'Đội ngũ chuyên môn' }, { icon: 'check', label: 'Bảo hành rõ ràng' },
    ];
    const grid = TNF.iconGrid({ x: a.x, y: a.y + 140, w: a.w, h: a.h - 160, items, accent: c.brand.colors.accent, t0: 0.15 });
    c.root.append(grid.el);
    c.state.grid = grid; c.state.title = title;
  },
  render(c) {
    c.state.grid.update(c.time);
    c.state.title.style.opacity = TNF.tween(c.time, 0, 1, 0, 0.4);
  },
}));
