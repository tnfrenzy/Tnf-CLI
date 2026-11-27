/*!
 * tnf-motion.js - deterministic motion-graphics library for TNF Code Video Studio.
 * Classic script (no modules, no dependencies). Sets window.TNF.
 *
 * CONTRACT: every pixel is a pure function of time t (seconds).
 *   window.__seek(t)  sets the whole page to time t (sync, may return a Promise: await it).
 *   window.__ready    Promise: fonts, images, <video> metadata/data loaded, scenes mounted.
 * Never use requestAnimationFrame, Date.now, performance.now, Math.random, setInterval, network.
 */
(function (global) {
  'use strict';
  const doc = global.document;
  const TNF = { version: '1.0.0', time: 0, scenes: [] };

  // ---------------------------------------------------------------- math
  /** Clamp v into [a, b]. */
  const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
  /** Linear interpolation. */
  const lerp = (a, b, k) => a + (b - a) * k;
  /** Smoothstep 0..1 between edges e0, e1. */
  const smoothstep = (e0, e1, x) => { const k = clamp((x - e0) / (e1 - e0)); return k * k * (3 - 2 * k); };
  /** Map v from [a,b] to [c,d] (clamped), optional ease. */
  const map = (v, a, b, c, d, ease) => lerp(c, d, resolveEase(ease)(clamp((v - a) / (b - a))));
  /** Fixed-precision number to string (stable DOM output). */
  const n2 = (v) => (Math.round(v * 100) / 100).toString();

  // ---------------------------------------------------------------- easing
  const c1 = 1.70158, c3 = c1 + 1, c4 = (2 * Math.PI) / 3;
  const rawEase = {
    linear: (p) => p,
    inQuad: (p) => p * p,
    outQuad: (p) => 1 - (1 - p) * (1 - p),
    inOutQuad: (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2),
    inCubic: (p) => p * p * p,
    outCubic: (p) => 1 - Math.pow(1 - p, 3),
    inOutCubic: (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
    inOutSine: (p) => -(Math.cos(Math.PI * p) - 1) / 2,
    outExpo: (p) => 1 - Math.pow(2, -10 * p),
    inBack: (p) => c3 * p * p * p - c1 * p * p,
    outBack: (p) => 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2),
    outElastic: (p) => Math.pow(2, -10 * p) * Math.sin((p * 10 - 0.75) * c4) + 1,
    step: (p) => (p >= 1 ? 1 : 0),
  };
  rawEase.easeIn = rawEase.inCubic;
  rawEase.easeOut = rawEase.outCubic;
  rawEase.easeInOut = rawEase.inOutCubic;
  /** Easing table. All map 0 to exactly 0 and 1 to exactly 1 (overshoot allowed in between). */
  const ease = {};
  Object.keys(rawEase).forEach((k) => {
    const f = rawEase[k];
    ease[k] = (p) => (p <= 0 ? 0 : p >= 1 ? 1 : f(p));
  });
  /** Accepts an easing name, a function, or undefined (linear). */
  function resolveEase(e) {
    if (typeof e === 'function') return e;
    if (typeof e === 'string' && ease[e]) return ease[e];
    return ease.linear;
  }

  /**
   * Value at time t moving from `from` to `to` during [t0, t1]. from/to may be numbers or equal-length arrays.
   * Before t0 returns from, after t1 returns to.
   * @example TNF.tween(t, 0, 1, 0.5, 1.2, 'outCubic')
   */
  function tween(t, from, to, t0, t1, easing) {
    const k = t1 > t0 ? resolveEase(easing)(clamp((t - t0) / (t1 - t0))) : t >= t1 ? 1 : 0;
    if (Array.isArray(from)) return from.map((f, i) => lerp(f, to[i], k));
    return lerp(from, to, k);
  }

  // ---------------------------------------------------------------- seeded random
  /** Stateless hash -> [0,1). Same (i, seed) always gives the same value. */
  function hash(i, seed) {
    let h = (Math.imul(i | 0, 374761393) + Math.imul((seed | 0) + 1, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  /**
   * Seeded PRNG (mulberry32). Returns next() in [0,1) with helpers range(a,b), int(a,b), pick(arr).
   * @example const r = TNF.rng(7); r.range(10, 20)
   */
  function rng(seed) {
    let a = seed | 0;
    const next = () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    next.range = (lo, hi) => lo + (hi - lo) * next();
    next.int = (lo, hi) => Math.floor(lo + (hi - lo + 1) * next());
    next.pick = (arr) => arr[Math.floor(next() * arr.length)];
    return next;
  }

  // ---------------------------------------------------------------- color
  function parseHex(c) {
    let s = String(c || '#000').replace('#', '');
    if (s.length === 3) s = s.split('').map((x) => x + x).join('');
    const v = parseInt(s.slice(0, 6), 16) || 0;
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }
  const color = {
    /** rgba string from hex + alpha. */
    rgba: (hex, a = 1) => { const [r, g, b] = parseHex(hex); return 'rgba(' + r + ',' + g + ',' + b + ',' + n2(a) + ')'; },
    /** Mix two hex colors, k=0 -> a, k=1 -> b. Returns #rrggbb. */
    mix: (a, b, k) => {
      const A = parseHex(a), B = parseHex(b);
      return '#' + A.map((x, i) => Math.round(lerp(x, B[i], k)).toString(16).padStart(2, '0')).join('');
    },
  };

  // ---------------------------------------------------------------- DOM helpers
  const SVGNS = 'http://www.w3.org/2000/svg';
  /** Assign style object; supports CSS custom props and individual transform props (translate, scale...). */
  function css(node, styles) {
    if (!styles) return node;
    if (typeof styles === 'string') { node.style.cssText += ';' + styles; return node; }
    Object.keys(styles).forEach((k) => {
      const v = styles[k];
      if (k.indexOf('-') >= 0) node.style.setProperty(k, v); else node.style[k] = v;
    });
    return node;
  }
  function addChildren(node, ch) {
    (Array.isArray(ch) ? ch : ch == null ? [] : [ch]).forEach((c) => {
      if (c == null || c === false) return;
      node.appendChild(typeof c === 'string' || typeof c === 'number' ? doc.createTextNode(String(c)) : c);
    });
    return node;
  }
  /**
   * Create an HTML element. props: style (object|string), text, html, class, any other key = attribute.
   * @example TNF.el('div', {class:'x', style:{left:'10px'}, text:'Xin chào'})
   */
  function el(tag, props, children) {
    const n = doc.createElement(tag);
    Object.keys(props || {}).forEach((k) => {
      const v = props[k];
      if (k === 'style') css(n, v);
      else if (k === 'text') n.textContent = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k === 'class') n.className = v;
      else n.setAttribute(k, v);
    });
    return addChildren(n, children);
  }
  /** Create an SVG element (namespaced). attrs are attributes. */
  function svg(tag, attrs, children) {
    const n = doc.createElementNS(SVGNS, tag);
    Object.keys(attrs || {}).forEach((k) => n.setAttribute(k, attrs[k]));
    return addChildren(n, children);
  }

  // ---------------------------------------------------------------- brand & layout
  /** Normalise brand.json (missing fields get defaults). Pass window.TNF_BRAND (set by brand.js). */
  function brandOf(b) {
    b = b || {};
    const sans = '"Segoe UI", "Be Vietnam Pro", Arial, sans-serif';
    const fam = (f) => (f ? '"' + String(f).replace(/"/g, '') + '", ' + sans : sans);
    const c = Object.assign({ primary: '#1e5bff', accent: '#ffc400', bg: '#06174a', text: '#ffffff' }, b.colors || {});
    const f = b.fonts || {};
    return {
      name: b.name || 'THƯƠNG HIỆU', tagline: b.tagline || '', logo: b.logo || '', colors: c,
      fonts: { heading: fam(f.heading), body: fam(f.body || f.heading) },
      hotline: b.hotline || '', website: b.website || '',
    };
  }
  /** Layout metrics for a W x H stage: top bar, bottom bar, padding and the free content `area` between bars. */
  function layout(w, h) {
    const topH = Math.round(h * 0.104), bottomH = Math.round(h * 0.073), pad = Math.round(w * 0.045);
    const y = topH + pad, bot = h - bottomH - pad;
    return { w, h, topH, bottomH, pad, area: { x: pad, y, w: w - 2 * pad, h: bot - y } };
  }
  /** Logo element: <img> when brand.logo is set, else bold text of brand.name. */
  function logo(brand, height, textColor) {
    if (brand.logo) return el('img', { src: brand.logo, style: { height: height + 'px', display: 'block' } });
    return el('div', { text: brand.name, style: { font: '900 ' + Math.round(height * 0.6) + 'px/' + height + 'px var(--f-heading)', color: textColor || brand.colors.primary, whiteSpace: 'nowrap' } });
  }

  // ---------------------------------------------------------------- text & numbers
  /**
   * Typewriter: the visible prefix of `text` at time t (starts t0, cps characters per second).
   * Unicode-safe (Vietnamese diacritics stay intact). opts.cursor (string) adds a blinking cursor.
   * @example el.textContent = TNF.typewriter('Xin chào', ctx.time, 0.3, 18, {cursor:'|'})
   */
  function typewriter(text, t, t0, cps, opts) {
    const chars = Array.from(String(text).normalize('NFC'));
    const n = Math.floor(clamp((t - t0) * (cps || 20), 0, chars.length));
    let out = chars.slice(0, n).join('');
    const cur = opts && opts.cursor;
    if (cur && (n < chars.length || Math.floor(t * 2) % 2 === 0)) out += cur;
    return out;
  }
  /**
   * Animated number string from `from` to `to` in [t0,t1]. opts: decimals, sep (thousands, default '.'),
   * dec (decimal mark, default ','), prefix, suffix, ease.
   * @example TNF.counter(0, 1250, ctx.time, 0, 1.5, {suffix:'+'})  // "1.250+"
   */
  function counter(from, to, t, t0, t1, opts) {
    const o = opts || {};
    const v = tween(t, from, to, t0, t1, o.ease || 'outCubic');
    const d = o.decimals || 0;
    const parts = v.toFixed(d).split('.');
    const sep = o.sep == null ? '.' : o.sep;
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, sep);
    return (o.prefix || '') + parts.join(o.dec == null ? ',' : o.dec) + (o.suffix || '');
  }
  /** Smooth periodic wave 0..1 (period seconds, optional phase 0..1). Map it yourself: 1 + 0.05 * TNF.pulse(t, 1.2). */
  const pulse = (t, period, phase) => 0.5 + 0.5 * Math.sin(2 * Math.PI * (t / (period || 1) + (phase || 0)));
  /**
   * Shrink font-size of `el` until its text fits maxW x maxH (px). Returns chosen size. Call in mount() or while
   * the scene is visible (needs layout). opts: min (default 12), max (default 200), nowrap.
   */
  function fit(node, maxW, maxH, opts) {
    const o = opts || {};
    let lo = o.min || 12, hi = o.max || 200;
    node.style.width = maxW + 'px';
    node.style.whiteSpace = o.nowrap ? 'nowrap' : 'normal';
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) / 2;
      node.style.fontSize = mid + 'px';
      if (node.scrollWidth <= maxW + 0.5 && node.scrollHeight <= maxH + 0.5) lo = mid; else hi = mid;
    }
    node.style.fontSize = Math.floor(lo) + 'px';
    return Math.floor(lo);
  }

  // ---------------------------------------------------------------- glitch
  /**
   * RGB channel split + horizontal jitter on `el`. amount 0..1 (0 clears). t defaults to the current seek time.
   * Uses CSS `filter` and `translate` (not `transform`), so it composes with your transforms. Deterministic: 24 steps/s.
   * @example TNF.glitch(card, 1 - ctx.tw(0, 1, 0, 0.5))
   */
  function glitch(node, amount, t) {
    const a = clamp(amount);
    if (a <= 0.001) { node.style.filter = ''; node.style.translate = ''; return node; }
    const f = Math.floor((t == null ? TNF.time : t) * 24);
    const dx = (hash(f, 11) - 0.5) * 2 * a * 30;
    const sp = a * 16 * (0.4 + hash(f, 23));
    node.style.translate = n2(dx) + 'px ' + n2((hash(f, 31) - 0.5) * a * 8) + 'px';
    node.style.filter = 'drop-shadow(' + n2(sp) + 'px 0 0 rgba(255,0,60,0.8)) drop-shadow(' + n2(-sp) + 'px 0 0 rgba(0,229,255,0.8))';
    return node;
  }

  // ---------------------------------------------------------------- scenes & timeline
  function normTransition(v, def) {
    if (v === false || v === 'none') return { type: 'none', dur: 0 };
    if (typeof v === 'string') return { type: v, dur: def.dur, dir: def.dir };
    return Object.assign({}, def, v || {});
  }
  /**
   * Define a scene. start/end in seconds. enter/exit: 'fade'|'slide'|'glitch'|'none' or {type, dur, dir:'up'|'down'|'left'|'right'}.
   * Overlap two scenes in time for a crossfade. mount(ctx) runs once after fonts load (build DOM into ctx.root, keep
   * references in ctx.state). render(ctx) runs on every seek and must only set styles/text from ctx values.
   * @example TNF.scene({id:'intro', start:0, end:3, enter:'glitch', mount(c){...}, render(c){...}})
   */
  function scene(def) {
    if (!def || !def.id || !(def.end > def.start)) throw new Error('TNF.scene needs id and end > start');
    const s = Object.assign({}, def);
    s.enter = normTransition(def.enter, { type: 'fade', dur: 0.4, dir: 'up' });
    s.exit = normTransition(def.exit, { type: 'fade', dur: 0.4, dir: 'up' });
    return s;
  }
  /**
   * Pure scene state at time t: {active, p (0..1 local), time (local seconds), dur, enter (0..1), exit (0..1; 0 = not leaving)}.
   */
  function sceneState(s, t) {
    const dur = s.end - s.start, time = t - s.start;
    const ed = s.enter ? s.enter.dur : 0, xd = s.exit ? s.exit.dur : 0;
    return {
      active: t >= s.start && t < s.end, p: clamp(time / dur), time, dur,
      enter: ed > 0 ? clamp(time / ed) : 1,
      exit: xd > 0 ? clamp((t - (s.end - xd)) / xd) : 0,
    };
  }
  /** Scenes active at t, in declaration order, with their state. */
  const timeline = (scenes, t) => scenes.map((s) => ({ scene: s, st: sceneState(s, t) })).filter((x) => x.st.active);

  function applyTransition(root, s, st, t, W, H) {
    const phase = st.exit > 0 ? s.exit : st.enter < 1 ? s.enter : null;
    const k = st.exit > 0 ? st.exit : st.enter;
    let op = 1, tr = '', amount = 0;
    if (phase) {
      const type = phase.type;
      const prog = st.exit > 0 ? 1 - k : k; // 0 hidden .. 1 shown
      if (type === 'fade') op = ease.inOutQuad(prog);
      else if (type === 'slide') {
        op = clamp(prog * 2);
        const d = (1 - ease.outCubic(prog)) * (st.exit > 0 ? -1 : 1);
        const dir = phase.dir || 'up';
        const dx = dir === 'left' ? 1 : dir === 'right' ? -1 : 0, dy = dir === 'up' ? 1 : dir === 'down' ? -1 : 0;
        tr = n2(dx * d * W * 0.2) + 'px ' + n2(dy * d * H * 0.08) + 'px';
      } else if (type === 'glitch') {
        amount = 1 - prog;
        op = hash(Math.floor(t * 30), 5) > amount * 0.7 ? 1 : 0.35;
        if (prog <= 0) op = 0;
      } else if (type === 'none') op = 1;
    }
    root.style.opacity = n2(op);
    root.style.translate = tr;
    if (amount > 0) glitch(root, amount, t); else root.style.filter = '';
  }

  // ---------------------------------------------------------------- icons & cards
  const ICONS = {
    phone: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z',
    gear: 'M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
    shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM8.5 12l2.5 2.5L16 9.5',
    bolt: 'M13 2L4 14h7l-1 8 9-12h-7z',
    check: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM7.5 12.5l3 3 6-6.5',
    building: 'M4 21V5l9-2v18M13 8l7 2v11M8 8h2M8 12h2M8 16h2M16 13h1M16 17h1',
    elevator: 'M5 3h14v18H5zM12 3v18M8.5 9.5L10 8l1.5 1.5M13.5 14.5L15 16l1.5-1.5',
    star: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z',
    wrench: 'M14.5 6.5a4 4 0 0 0-5 5L3 18l3 3 6.5-6.5a4 4 0 0 0 5-5L14.5 12 12 9.5z',
    user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c0-4 4-6 8-6s8 2 8 6',
  };
  /** Inline SVG markup for a built-in icon name (phone gear shield bolt check building elevator star wrench user). */
  function icon(name, o) {
    const x = o || {}, size = x.size || 64;
    return '<svg xmlns="' + SVGNS + '" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="' + (x.color || 'currentColor') +
      '" stroke-width="' + (x.stroke || 1.7) + '" stroke-linecap="round" stroke-linejoin="round"><path d="' + (ICONS[name] || ICONS.star) + '"/></svg>';
  }
  /**
   * Rounded card (div). opts: x,y (absolute px, optional), w,h, radius, bg, border, shadow, pad, children, html.
   * @example TNF.card({x:100,y:900,w:880,h:200,bg:'#fff',children:[TNF.el('div',{text:'Xin chào'})]})
   */
  function card(o) {
    const n = el('div', { style: {
      boxSizing: 'border-box', borderRadius: (o.radius == null ? 36 : o.radius) + 'px', background: o.bg || 'rgba(255,255,255,0.08)',
      border: o.border || '2px solid rgba(255,255,255,0.18)', boxShadow: o.shadow || '0 18px 40px rgba(0,0,0,0.35)',
      padding: (o.pad == null ? 24 : o.pad) + 'px', overflow: 'hidden',
    } });
    if (o.w != null) n.style.width = o.w + 'px';
    if (o.h != null) n.style.height = o.h + 'px';
    if (o.x != null || o.y != null) { n.style.position = 'absolute'; n.style.left = (o.x || 0) + 'px'; n.style.top = (o.y || 0) + 'px'; }
    if (o.html) n.innerHTML = o.html;
    return addChildren(n, o.children);
  }
  /**
   * Icon grid (default 2 cols x 4 rows) with glitch entrance per cell. items: [{icon:'gear'|svgMarkup, label}].
   * Returns {el, update(time)} where time = local seconds (ctx.time); cells appear every `stagger` s starting at opts.t0.
   * @example const g = TNF.iconGrid({x:48,y:300,w:984,h:1100,items}); ctx.root.appendChild(g.el); g.update(ctx.time)
   */
  function iconGrid(o) {
    const cols = o.cols || 2, rows = o.rows || 4, gap = o.gap || 28, stagger = o.stagger == null ? 0.14 : o.stagger, gd = o.glitchDur || 0.5;
    const cw = (o.w - gap * (cols - 1)) / cols, chh = (o.h - gap * (rows - 1)) / rows;
    const accent = o.accent || '#ffc400', root = el('div', { style: { position: 'absolute', left: (o.x || 0) + 'px', top: (o.y || 0) + 'px', width: o.w + 'px', height: o.h + 'px' } });
    const cells = (o.items || []).slice(0, cols * rows).map((it, i) => {
      const lab = el('div', { text: it.label || '', style: { font: '700 ' + (o.labelSize || 34) + 'px/1.15 var(--f-body)', textAlign: 'center', color: 'var(--c-text)' } });
      const ic = el('div', { html: /^</.test(it.icon || '') ? it.icon : icon(it.icon || 'star', { size: Math.round(chh * 0.42), color: accent }) });
      const c = card({ x: (i % cols) * (cw + gap), y: Math.floor(i / cols) * (chh + gap), w: cw, h: chh, radius: 32, children: [ic, lab] });
      css(c, { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '14px', opacity: 0 });
      root.appendChild(c);
      return c;
    });
    return { el: root, cells, update(time) {
      const t0 = o.t0 || 0;
      cells.forEach((c, i) => {
        const e = clamp((time - (t0 + i * stagger)) / gd);
        c.style.opacity = e > 0 ? (e < 1 && hash(Math.floor(time * 30) + i, 3) < 0.25 * (1 - e) ? '0.4' : '1') : '0';
        c.style.scale = n2(lerp(0.85, 1, ease.outBack(e)));
        glitch(c, 1 - e, time + i);
      });
    } };
  }

  // ---------------------------------------------------------------- isometric helpers (return SVG markup strings)
  const COS30 = 0.8660254037844386, SIN30 = 0.5;
  const iso = {
    /**
     * Project world (x,y,z) to screen. o: {ox, oy, s} origin and scale. x grows right-down, y left-down, z up.
     * @returns {[number, number]}
     */
    project(x, y, z, o) {
      const s = (o && o.s) || 1;
      return [((o && o.ox) || 0) + (x - y) * COS30 * s, ((o && o.oy) || 0) + (x + y) * SIN30 * s - z * s];
    },
    /** Wrap markup in an <svg> of given size (set host.innerHTML = TNF.iso.wrap(...)). */
    wrap(w, h, inner) { return '<svg xmlns="' + SVGNS + '" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" style="overflow:visible">' + inner + '</svg>'; },
    /**
     * Isometric box. o: x,y,z (base corner), w (x size), d (y size), h (height), grow 0..1 (height progress),
     * color, opacity, view {ox,oy,s}. Faces are shaded automatically.
     * @example TNF.iso.box({x:0,y:0,w:100,d:100,h:60,color:'#1e5bff',grow:p,view})
     */
    box(o) {
      const v = o.view || {}, H = o.h * (o.grow == null ? 1 : clamp(o.grow)), z = o.z || 0, col = o.color || '#1e5bff';
      const P = (x, y, zz) => iso.project(x, y, zz, v).map(n2).join(',');
      const x0 = o.x, y0 = o.y, x1 = o.x + o.w, y1 = o.y + o.d, zt = z + H;
      const poly = (pts, c) => '<polygon points="' + pts.join(' ') + '" fill="' + c + '" stroke="' + color.rgba('#ffffff', 0.35) + '" stroke-width="1.5" stroke-linejoin="round"/>';
      return '<g opacity="' + n2(o.opacity == null ? 1 : o.opacity) + '">' +
        poly([P(x0, y1, z), P(x1, y1, z), P(x1, y1, zt), P(x0, y1, zt)], color.mix(col, '#000000', 0.25)) +
        poly([P(x1, y0, z), P(x1, y1, z), P(x1, y1, zt), P(x1, y0, zt)], color.mix(col, '#000000', 0.5)) +
        poly([P(x0, y0, zt), P(x1, y0, zt), P(x1, y1, zt), P(x0, y1, zt)], color.mix(col, '#ffffff', 0.25)) + '</g>';
    },
    /**
     * Sort boxes/buildings back-to-front (painter's algorithm) so near ones cover far ones: draw in the returned order.
     * Depth of an item = centre x + centre y (+ z); a larger value is nearer to the viewer. Returns a new array.
     * @example TNF.iso.sortBack(blocks).forEach((b) => { out += TNF.iso.building(Object.assign({view}, b)); });
     */
    sortBack(items) {
      const depth = (o) => o.x + (o.w || 0) / 2 + o.y + (o.d || 0) / 2 + (o.z || 0) * 0.01;
      return items.map((o, i) => [o, i]).sort((p, q) => depth(p[0]) - depth(q[0]) || p[1] - q[1]).map((p) => p[0]);
    },
    /** Box with floor lines on both visible faces. Extra o: floors (default 6). */
    building(o) {
      const n = o.floors || 6, H = o.h * (o.grow == null ? 1 : clamp(o.grow)), v = o.view || {}, z = o.z || 0;
      let s = iso.box(o);
      for (let i = 1; i < n; i++) {
        const zz = z + (H * i) / n, P = (x, y) => iso.project(x, y, zz, v).map(n2).join(',');
        s += '<polyline points="' + P(o.x, o.y + o.d) + ' ' + P(o.x + o.w, o.y + o.d) + ' ' + P(o.x + o.w, o.y) + '" fill="none" stroke="' + color.rgba('#ffffff', 0.3) + '" stroke-width="2"/>';
      }
      return s;
    },
    /**
     * Animated dashed connector through world points [[x,y,z],...]. o: view, t (seconds), speed (px/s, default 120),
     * progress 0..1 (draws only that fraction of the path), color, width, dash.
     * Dots "run" because stroke-dashoffset = -t*speed.
     * @example TNF.iso.connector([[0,0,0],[200,0,0],[200,150,0]], {view, t: ctx.time, progress: ctx.tw(0,1,0,1)})
     */
    connector(pts, o) {
      const v = o.view || {}, sp = o.speed == null ? 120 : o.speed, pr = o.progress == null ? 1 : clamp(o.progress);
      const sc = pts.map((p) => iso.project(p[0], p[1], p[2] || 0, v));
      let total = 0;
      for (let i = 1; i < sc.length; i++) total += Math.hypot(sc[i][0] - sc[i - 1][0], sc[i][1] - sc[i - 1][1]);
      let left = total * pr;
      const out = [sc[0]];
      for (let i = 1; i < sc.length && left > 0; i++) {
        const seg = Math.hypot(sc[i][0] - sc[i - 1][0], sc[i][1] - sc[i - 1][1]);
        if (left >= seg) { out.push(sc[i]); left -= seg; } else { const k = left / seg; out.push([lerp(sc[i - 1][0], sc[i][0], k), lerp(sc[i - 1][1], sc[i][1], k)]); left = 0; }
      }
      if (out.length < 2) return '';
      const d = 'M' + out.map((p) => n2(p[0]) + ' ' + n2(p[1])).join(' L');
      const c = o.color || '#ffc400', w = o.width || 5;
      return '<path d="' + d + '" fill="none" stroke="' + color.rgba(c, 0.25) + '" stroke-width="' + (w + 8) + '" stroke-linecap="round" stroke-linejoin="round"/>' +
        '<path d="' + d + '" fill="none" stroke="' + c + '" stroke-width="' + w + '" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="' + (o.dash || '2 16') + '" stroke-dashoffset="' + n2(-(o.t || 0) * sp) + '"/>';
    },
  };

  // ---------------------------------------------------------------- layers (background / fixed bars / frame)
  /**
   * Background: deep gradient + twinkling stars + slowly rotating light rays on a canvas. Layer {el, update(t)}.
   * opts: seed, count (default 140), rays (default 7), width, height, center [fx, fy].
   */
  function starfield(o) {
    const x = o || {}, W = x.width || 1080, H = x.height || 1920, seed = x.seed == null ? 1 : x.seed, count = x.count == null ? 140 : x.count;
    const rays = x.rays == null ? 7 : x.rays, ctr = x.center || [0.5, 0.36], bg = x.bg || '#06174a', tint = x.color || '#7fb2ff';
    const r = rng(seed);
    const stars = [];
    for (let i = 0; i < count; i++) stars.push({ x: r() * W, y: r() * H, r: r.range(0.8, 2.6), ph: r() * 6.283, fq: r.range(0.8, 3.2), sp: r.range(2, 14), big: r() < 0.12 });
    const rayDefs = [];
    for (let i = 0; i < rays; i++) rayDefs.push({ a: (i / rays) * 6.283 + r.range(-0.2, 0.2), w: r.range(0.05, 0.14), s: r.range(0.015, 0.05) * (i % 2 ? -1 : 1) });
    const cv = el('canvas', { width: W, height: H, style: { position: 'absolute', left: 0, top: 0, width: W + 'px', height: H + 'px' } });
    const g = cv.getContext ? cv.getContext('2d') : null;
    return { el: cv, update(t) {
      if (!g) return;
      const cx = ctr[0] * W, cy = ctr[1] * H;
      const bgG = g.createRadialGradient(cx, cy, 0, cx, cy, Math.hypot(W, H) * 0.7);
      bgG.addColorStop(0, color.mix(bg, '#ffffff', 0.2)); bgG.addColorStop(1, color.mix(bg, '#000000', 0.35));
      g.globalCompositeOperation = 'source-over'; g.fillStyle = bgG; g.fillRect(0, 0, W, H);
      g.globalCompositeOperation = 'lighter';
      const len = Math.hypot(W, H);
      rayDefs.forEach((d) => {
        const a = d.a + t * d.s, ex = cx + Math.cos(a) * len, ey = cy + Math.sin(a) * len;
        const gr = g.createLinearGradient(cx, cy, ex, ey);
        gr.addColorStop(0, color.rgba(tint, 0.2)); gr.addColorStop(1, color.rgba(tint, 0));
        g.fillStyle = gr; g.beginPath(); g.moveTo(cx, cy);
        g.lineTo(cx + Math.cos(a - d.w / 2) * len, cy + Math.sin(a - d.w / 2) * len);
        g.lineTo(cx + Math.cos(a + d.w / 2) * len, cy + Math.sin(a + d.w / 2) * len);
        g.closePath(); g.fill();
      });
      stars.forEach((s) => {
        const yy = (((s.y - t * s.sp) % H) + H) % H, a = 0.2 + 0.8 * Math.pow(pulse(t * s.fq, 1, s.ph), 2);
        g.fillStyle = 'rgba(255,255,255,' + a.toFixed(3) + ')';
        g.beginPath(); g.arc(s.x, yy, s.r, 0, 6.2832); g.fill();
        if (s.big) {
          g.strokeStyle = 'rgba(255,255,255,' + (a * 0.7).toFixed(3) + ')'; g.lineWidth = 1.5; g.beginPath();
          g.moveTo(s.x - s.r * 5 * a, yy); g.lineTo(s.x + s.r * 5 * a, yy); g.moveTo(s.x, yy - s.r * 5 * a); g.lineTo(s.x, yy + s.r * 5 * a); g.stroke();
        }
      });
      g.globalCompositeOperation = 'source-over';
    } };
  }

  /**
   * Fixed white top bar: brand logo + progress bar of N cells (fills with global progress). Layer {el, update(t, ctx)}.
   * opts: brand, steps (default 8). Slides in during the first 0.6 s.
   */
  function topBar(o) {
    const b = brandOf(o.brand), L = layout(o.width || 1080, o.height || 1920), steps = o.steps || 8;
    const root = el('div', { style: { position: 'absolute', left: 0, top: 0, width: L.w + 'px', height: L.topH + 'px', background: '#fff', boxShadow: '0 8px 30px rgba(0,0,0,0.35)' } });
    const lg = logo(b, Math.round(L.topH * 0.46), b.colors.primary);
    css(lg, { position: 'absolute', left: L.pad + 'px', top: Math.round(L.topH * 0.16) + 'px' });
    const row = el('div', { style: { position: 'absolute', left: L.pad + 'px', right: L.pad + 'px', bottom: Math.round(L.topH * 0.14) + 'px', height: '12px', display: 'flex', gap: '8px' } });
    const fills = [];
    for (let i = 0; i < steps; i++) {
      const f = el('div', { style: { height: '100%', width: '0%', background: b.colors.primary, borderRadius: '6px' } });
      fills.push(f);
      row.appendChild(el('div', { style: { flex: '1', background: color.rgba(b.colors.primary, 0.18), borderRadius: '6px', overflow: 'hidden' } }, [f]));
    }
    addChildren(root, [lg, row]);
    return { el: root, update(t, c) {
      const pr = c.progress * steps;
      fills.forEach((f, i) => { f.style.width = n2(clamp(pr - i) * 100) + '%'; });
      root.style.translate = '0px ' + n2(tween(t, -L.topH, 0, 0, 0.6, 'outCubic')) + 'px';
    } };
  }

  /** Fixed yellow bottom bar "HOTLINE <number>" + website, with a slow light sheen. Layer {el, update(t)}. */
  function bottomBar(o) {
    const b = brandOf(o.brand), L = layout(o.width || 1080, o.height || 1920), ink = color.mix(b.colors.bg, '#000000', 0.3);
    const root = el('div', { style: { position: 'absolute', left: 0, top: (L.h - L.bottomH) + 'px', width: L.w + 'px', height: L.bottomH + 'px', background: b.colors.accent, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '28px', boxShadow: '0 -8px 30px rgba(0,0,0,0.35)' } });
    const sheen = el('div', { style: { position: 'absolute', top: 0, width: '220px', height: '100%', background: 'linear-gradient(90deg, rgba(255,255,255,0), rgba(255,255,255,0.45), rgba(255,255,255,0))', transform: 'skewX(-20deg)' } });
    const txt = el('div', { text: ('HOTLINE ' + b.hotline).trim(), style: { font: '900 ' + Math.round(L.bottomH * 0.42) + 'px/1 var(--f-heading)', color: ink, letterSpacing: '1px', whiteSpace: 'nowrap', position: 'relative' } });
    addChildren(root, [sheen, txt]);
    if (b.website) addChildren(root, [el('div', { text: b.website, style: { font: '700 ' + Math.round(L.bottomH * 0.22) + 'px/1 var(--f-body)', color: ink, position: 'relative', opacity: '0.8' } })]);
    return { el: root, update(t) {
      root.style.translate = '0px ' + n2(tween(t, L.bottomH, 0, 0, 0.6, 'outCubic')) + 'px';
      sheen.style.left = n2(lerp(-300, L.w + 100, (t * 0.35) % 1)) + 'px';
    } };
  }

  /**
   * Sci-fi 4-corner frame (SVG). opts: width, height, top, bottom (px; default = free area between bars), inset, len, thick, color.
   * Draws itself in during the first second, then breathes. Layer {el, update(t)}.
   */
  function frame(o) {
    const x = o || {}, L = layout(x.width || 1080, x.height || 1920), c = x.color || '#ffc400';
    const l = L.pad * 0.6, r = L.w - L.pad * 0.6, tp = x.top != null ? x.top : L.topH + L.pad * 0.5, bt = L.h - (x.bottom != null ? x.bottom : L.bottomH + L.pad * 0.5);
    const len = x.len || 150, cut = 28, th = x.thick || 5;
    const corners = [
      'M' + l + ' ' + (tp + len) + ' V' + (tp + cut) + ' L' + (l + cut) + ' ' + tp + ' H' + (l + len),
      'M' + (r - len) + ' ' + tp + ' H' + (r - cut) + ' L' + r + ' ' + (tp + cut) + ' V' + (tp + len),
      'M' + r + ' ' + (bt - len) + ' V' + (bt - cut) + ' L' + (r - cut) + ' ' + bt + ' H' + (r - len),
      'M' + (l + len) + ' ' + bt + ' H' + (l + cut) + ' L' + l + ' ' + (bt - cut) + ' V' + (bt - len),
    ];
    const root = svg('svg', { width: L.w, height: L.h, viewBox: '0 0 ' + L.w + ' ' + L.h, style: 'position:absolute;left:0;top:0;pointer-events:none' });
    const outline = svg('rect', { x: l, y: tp, width: r - l, height: bt - tp, fill: 'none', stroke: color.rgba(c, 0.22), 'stroke-width': 2 });
    const paths = corners.map((d) => svg('path', { d, fill: 'none', stroke: c, 'stroke-width': th, 'stroke-linecap': 'square', pathLength: 1 }));
    addChildren(root, [outline].concat(paths));
    return { el: root, update(t) {
      const p = tween(t, 0, 1, 0.1, 1.1, 'outCubic');
      paths.forEach((pa) => { pa.style.strokeDasharray = '1 1'; pa.style.strokeDashoffset = n2(1 - p); });
      root.style.opacity = n2(0.75 + 0.25 * pulse(t, 2.4));
    } };
  }

  // ---------------------------------------------------------------- video footage
  const videoRegistry = [];
  /**
   * Register a stock-footage <video> so t drives currentTime. opts: start (scene time offset, s), loop, rate.
   * Returns {el, ready, seek(t)}; return seek(ctx.t) from render() so the renderer waits for 'seeked'.
   * Call it in mount() (or before TNF.start). Video is forced muted/paused.
   * @example const v = TNF.video(ctx.root.querySelector('video'), {start: 6, loop: true}); render(c){ return v.seek(c.t) }
   */
  function video(node, o) {
    const x = o || {};
    node.muted = true; node.playsInline = true; node.preload = 'auto'; node.loop = false;
    if (node.pause) node.pause();
    const ready = new Promise((res) => {
      if (node.readyState >= 2) res();
      else { node.addEventListener('loadeddata', () => res(), { once: true }); node.addEventListener('error', () => res(), { once: true }); }
    });
    const h = { el: node, ready, seek(t) {
      let tt = Math.max(0, (t - (x.start || 0)) * (x.rate || 1));
      const d = node.duration;
      if (isFinite(d) && d > 0) tt = x.loop ? tt % d : Math.min(tt, Math.max(0, d - 0.04));
      if (Math.abs(node.currentTime - tt) < 0.0005) return Promise.resolve();
      return new Promise((res) => {
        let done = false;
        const fin = () => { if (done) return; done = true; node.removeEventListener('seeked', fin); res(); };
        node.addEventListener('seeked', fin);
        setTimeout(fin, 3000);
        node.currentTime = tt;
      });
    } };
    videoRegistry.push(h);
    return h;
  }

  // ---------------------------------------------------------------- start / seek
  function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); }
  /** Fingerprint of the current picture: stage HTML + every canvas bitmap. Equal strings = identical frame state. */
  function snapshot() {
    const st = global.__tnfStage;
    let html = '';
    Array.from(st.children).forEach((c) => { if (c.style.display !== 'none') html += c.outerHTML; }); // hidden scenes are not part of the picture
    let s = hashStr(html);
    st.querySelectorAll('canvas').forEach((c) => { s += '|' + hashStr(c.toDataURL()); });
    return s;
  }

  /**
   * Boot the page. Registers window.__seek and window.__ready.
   * o: {duration (s), fps, width, height, scenes: [TNF.scene], bg: [layers under scenes], fg: [layers over scenes], brand}.
   * Layers are objects {el, update(t, ctx)}. Debug: open index.html?t=2.5 to show a time, ?selftest=1,5,1 to verify determinism.
   */
  function start(o) {
    const W = o.width || 1080, H = o.height || 1920, duration = o.duration || 10;
    const brand = brandOf(o.brand || global.TNF_BRAND), L = layout(W, H), scenes = o.scenes || TNF.scenes;
    doc.documentElement.style.cssText = 'margin:0;background:#000;overflow:hidden';
    doc.body.style.cssText = 'margin:0;overflow:hidden;background:#000';
    let stage = doc.getElementById('stage');
    if (!stage) { stage = el('div', { id: 'stage' }); doc.body.appendChild(stage); }
    css(stage, { position: 'absolute', left: '0px', top: '0px', width: W + 'px', height: H + 'px', overflow: 'hidden', background: brand.colors.bg, color: brand.colors.text, fontFamily: brand.fonts.body,
      '--c-primary': brand.colors.primary, '--c-accent': brand.colors.accent, '--c-bg': brand.colors.bg, '--c-text': brand.colors.text, '--f-heading': brand.fonts.heading, '--f-body': brand.fonts.body });
    stage.innerHTML = '';
    global.__tnfStage = stage;
    const lctx = (t) => ({ t, duration, progress: clamp(t / duration), w: W, h: H, layout: L, brand });
    (o.bg || []).forEach((l) => stage.appendChild(l.el));
    const runtimes = scenes.map((s) => {
      const root = el('div', { 'data-scene': s.id, style: { position: 'absolute', left: '0px', top: '0px', width: W + 'px', height: H + 'px', display: 'none' } });
      stage.appendChild(root);
      return { s, root, state: {}, shown: false };
    });
    (o.fg || []).forEach((l) => stage.appendChild(l.el));
    const ctxOf = (rt, t, st) => ({
      t, time: st.time, dur: st.dur, p: st.p, enter: st.enter, exit: st.exit, w: W, h: H, layout: L, area: L.area, brand, root: rt.root, state: rt.state, scene: rt.s, duration,
      tw: (from, to, t0, t1, e) => tween(st.time, from, to, t0, t1, e),
    });
    let ready = false;
    const thenables = (list) => list.filter((p) => p && typeof p.then === 'function');

    function apply(t0) {
      const t = clamp(+t0 || 0, 0, duration - 1e-6);
      TNF.time = t;
      const pend = [], lc = lctx(t);
      (o.bg || []).forEach((l) => pend.push(l.update(t, lc)));
      runtimes.forEach((rt) => {
        const st = sceneState(rt.s, t);
        if (!st.active) { const rs = rt.root.style; rs.display = 'none'; rs.opacity = ''; rs.translate = ''; rs.filter = ''; return; }
        rt.root.style.display = 'block';
        applyTransition(rt.root, rt.s, st, t, W, H);
        if (rt.s.render) pend.push(rt.s.render(ctxOf(rt, t, st)));
      });
      (o.fg || []).forEach((l) => pend.push(l.update(t, lc)));
      const th = thenables(pend);
      return th.length ? Promise.all(th).then(() => undefined) : undefined;
    }

    const fontsP = doc.fonts && doc.fonts.ready ? doc.fonts.ready : Promise.resolve();
    const readyP = fontsP.then(() => {
      runtimes.forEach((rt) => {
        if (!rt.s.mount) return;
        rt.root.style.display = 'block'; rt.root.style.visibility = 'hidden';
        rt.s.mount(ctxOf(rt, 0, sceneState(rt.s, rt.s.start)));
        rt.root.style.display = 'none'; rt.root.style.visibility = '';
      });
      return Promise.all(videoRegistry.map((v) => v.ready).concat(Array.from(doc.images).map((im) => (im.decode ? im.decode().catch(() => undefined) : undefined))));
    }).then(() => doc.fonts && doc.fonts.ready).then(() => {
      ready = true;
      return Promise.resolve(apply(0));
    }).then(() => {
      const q = new URLSearchParams(global.location ? global.location.search : '');
      if (q.has('t')) return apply(parseFloat(q.get('t')));
      if (q.has('selftest')) {
        const times = q.get('selftest').split(',').map(parseFloat), out = [];
        return times.reduce((pr, tt) => pr.then(() => apply(tt)).then(() => { out.push({ t: tt, snap: snapshot() }); }), Promise.resolve()).then(() => {
          doc.body.appendChild(el('pre', { id: 'tnf-selftest', text: JSON.stringify(out) }));
        });
      }
      return undefined;
    }).then(() => undefined);

    global.__ready = readyP;
    global.__seek = function (t) { return ready ? apply(t) : readyP.then(() => apply(t)); };
    return { duration, fps: o.fps || 30, width: W, height: H, seek: global.__seek, ready: readyP };
  }

  Object.assign(TNF, {
    clamp, lerp, map, smoothstep, ease, tween, hash, rng, color, el, svg, css, brand: brandOf, layout, logo,
    typewriter, counter, pulse, fit, glitch, scene, sceneState, timeline, icon, icons: ICONS, card, iconGrid, iso,
    starfield, topBar, bottomBar, frame, video, snapshot, start,
  });
  global.TNF = TNF;
})(typeof window !== 'undefined' ? window : globalThis);
