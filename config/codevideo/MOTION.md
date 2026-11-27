# Thư viện chuyển động `tnf-motion.js` (Xưởng Dựng Video)

Tệp `lib/tnf-motion.js` do app cấp, KHÔNG sửa. Chỉ viết `index.html` và `scenes/*.js`. Đọc `template/` làm mẫu (dọc 1080x1920, 30 fps).
Trang chạy trong Edge/Chrome headless; renderer gọi `__seek(i/fps)` rồi chụp từng khung.

## 1. Hợp đồng xác định
- Mọi hình là hàm thuần của thời gian `t` (giây). Cùng `t` phải cho cùng ảnh, theo bất kỳ thứ tự seek nào.
- `TNF.start({duration, fps, width, height, scenes, bg, fg, brand})` đăng ký:
  - `window.__seek(t)`: đặt cả trang về `t`, đồng bộ; có thể trả Promise (video chờ `seeked`), renderer sẽ await.
  - `window.__ready`: Promise resolve khi phông, ảnh, `<video>` đã nạp và các cảnh đã `mount`.
- Gỡ lỗi: mở `index.html?t=2.5` (hiện thời điểm 2.5 s), `?selftest=1,5,1` (in vân tay khung vào `#tnf-selftest`; hai khung cùng `t` phải trùng).

## 2. Đừng làm
- Không `requestAnimationFrame`, `setTimeout/setInterval` để vẽ, `Date.now`, `performance.now`, `new Date`, `Math.random` (dùng `TNF.rng(seed)` / `TNF.hash`).
- Không CSS `animation`/`transition`/`@keyframes` (không phụ thuộc đồng hồ thật); mọi chuyển động tính từ `ctx.time`.
- Không mạng: không CDN, Google Fonts, `fetch`, `XMLHttpRequest`, URL `http(s)`. Không đọc tệp ngoài thư mục dự án; chỉ đường dẫn tương đối (`assets/...`). Không ES module (`type="module"`, `import`); chỉ `<script src>` cổ điển, vì trang mở bằng `file://`.
- Không giữ trạng thái tích lũy giữa các lần `render` (không `x += ...`). Mỗi lần render đặt lại mọi style/text chỉ từ `ctx`.
- Không dùng `transform` ở phần tử đã bị `glitch`/chuyển cảnh chạm vào; dùng thuộc tính riêng `translate`, `scale`, `rotate` (an toàn khi gộp).
- Không bịa số liệu, giá, cam kết; chỉ dùng chữ/số do người dùng cung cấp. Hotline/website lấy từ brand.

## 3. Cấu trúc dự án
```
index.html   nạp lib/tnf-motion.js, brand.js, scenes/*.js rồi gọi TNF.start
brand.js     window.TNF_BRAND = {...} (bản script của brand.json; file:// không fetch được JSON)
scenes/NN-ten.js   mỗi tệp: TNF.scenes.push(TNF.scene({...}))
assets/      logo, ảnh, video tư liệu (đường dẫn tương đối)
```
`TNF.scenes` là mảng mặc định; `TNF.start({scenes: TNF.scenes})`. Thời lượng/khung cảnh lấy từ `project.json`.

## 4. Bố cục khung dọc 1080x1920
`TNF.layout(w, h)` trả `{topH:200, bottomH:140, pad:49, area:{x,y,w,h}}`.
- Thanh trên (logo + tiến trình) chiếm y 0..200; thanh vàng HOTLINE chiếm y 1780..1920: không đặt nội dung ở đó.
- Vùng nội dung `ctx.area` (khoảng x 49..1031, y 249..1731). Khung viền 4 góc bao vùng này.
- Chữ tiêu đề 100..150 px, chữ phụ 48..60 px, nhãn >= 34 px (xem trên điện thoại). Chữ Việt có dấu: đặt `line-height` >= 1.1; dùng `TNF.fit` để chữ dài không tràn.
- Mỗi cảnh có `ctx.root` (div phủ 1080x1920, gốc tọa độ trái trên); đặt phần tử `position:absolute` theo px.

## 5. Tham chiếu API (`window.TNF`)
**Toán/easing**
- `TNF.ease`: `linear inQuad outQuad inOutQuad inCubic outCubic inOutCubic inOutSine outExpo inBack outBack outElastic step easeIn easeOut easeInOut`. Đều có f(0)=0, f(1)=1.
- `TNF.tween(t, from, to, t0, t1, ease)`: giá trị tại `t`, kẹp ngoài [t0,t1]; `from/to` là số hoặc mảng. `ease` là tên hoặc hàm. Ví dụ `TNF.tween(c.time, 0, 1, 0.5, 1.2, 'outBack')`.
- `clamp(v,a,b)`, `lerp(a,b,k)`, `smoothstep(e0,e1,x)`, `map(v,a,b,c,d,ease)`.
- `TNF.rng(seed)` PRNG có hạt giống: `r()`, `r.range(a,b)`, `r.int(a,b)`, `r.pick(arr)`. `TNF.hash(i, seed)` giá trị [0,1) không trạng thái.
- `TNF.pulse(t, period, phase)` sóng mượt 0..1. Ví dụ `scale = 1 + 0.03 * TNF.pulse(t, 1.2)`.
- `TNF.color.rgba('#fff', .5)`, `TNF.color.mix(a, b, k)`.

**Cảnh**
```js
TNF.scenes.push(TNF.scene({
  id: 'intro', start: 0, end: 3,
  enter: 'glitch',                          // 'fade'|'slide'|'glitch'|'none' hoặc {type,dur,dir:'up|down|left|right'}
  exit: { type: 'slide', dur: 0.5, dir: 'up' },
  mount(c)  { /* chạy 1 lần: dựng DOM vào c.root, cất tham chiếu vào c.state */ },
  render(c) { /* mỗi lần seek: chỉ đặt style/text từ c; có thể trả Promise */ },
}));
```
Chồng thời gian hai cảnh = crossfade. `ctx` gồm: `t` (toàn cục), `time` (giây trong cảnh), `dur`, `p` (0..1), `enter`/`exit` (0..1), `w`,`h`, `area`, `layout`, `brand`, `root`, `state`, `tw(from,to,t0,t1,ease)` (tween theo `time`). Chỉ cảnh đang hiển thị mới được `render`.

**Chữ/số**
- `TNF.typewriter(text, t, t0, cps, {cursor:'|'})` trả chuỗi đang hiện (an toàn dấu tiếng Việt). `el.textContent = TNF.typewriter('Xin chào', c.time, 0.3, 20)`.
- `TNF.counter(from, to, t, t0, t1, {decimals, sep:'.', dec:',', prefix, suffix, ease})` trả chuỗi, vd `"1.250+"`.
- `TNF.fit(el, maxW, maxH, {min, max, nowrap})` co cỡ chữ vừa khung, trả cỡ đã chọn. Chỉ gọi trong `mount` (sau khi `el` đã nằm trong `c.root`).

**Hiệu ứng**
- `TNF.glitch(el, amount, t?)` tách kênh RGB + lệch ngang; `amount` 0..1, 0 là xóa. Ví dụ `TNF.glitch(card, 1 - c.tw(0,1,0,0.5), c.t)`.

**DOM/SVG**
- `TNF.el(tag, {style, text, html, class, ...attr}, children)`, `TNF.svg(tag, attrs, children)`, `TNF.css(node, styleObj)`.
- `TNF.icon(name, {size, color, stroke})` trả markup SVG; tên: `phone gear shield bolt check building elevator star wrench user`.
- `TNF.card({x,y,w,h,radius,bg,border,shadow,pad,children,html})` thẻ bo góc (absolute nếu có x/y).
- `TNF.logo(brand, height)` ảnh logo hoặc chữ tên thương hiệu.
- `TNF.iconGrid({x,y,w,h,cols:2,rows:4,items:[{icon,label}],accent,t0,stagger,labelSize})` trả `{el, update(time)}`; từng ô vào cảnh bằng glitch. Gọi `grid.update(c.time)` trong `render`.

**Isometric** (hàm trả chuỗi SVG; gán `host.innerHTML = TNF.iso.wrap(w, h, markup)` mỗi lần render)
- `view = {ox, oy, s}` gốc và tỉ lệ; `TNF.iso.project(x,y,z,view)` -> `[sx,sy]`.
- `TNF.iso.box({x,y,z,w,d,h,color,grow,opacity,view})`, `TNF.iso.building({... floors})`; `grow` 0..1 là tiến độ cao lên.
- `TNF.iso.connector(points3d, {view, t, speed, progress, color, width, dash})` đường nối chấm chạy (`t` = giây; `progress` vẽ dần 0..1).
- Thứ tự vẽ: khối ở gần (x+y lớn) phải vẽ SAU khối ở xa, nếu không khối xa đè lên khối gần. Dùng `TNF.iso.sortBack(items)` (trả mảng mới xếp từ xa đến gần, mỗi phần tử `{x,y,w,d,z?}`) rồi vẽ theo thứ tự đó, tòa trung tâm cũng nằm trong danh sách; vẽ đường nối TRƯỚC các khối.

**Lớp cố định** (truyền vào `TNF.start`; đối tượng `{el, update(t, ctx)}`)
- `bg: [TNF.starfield({seed, count:140, rays:7, bg})]` nền sao lấp lánh + tia sáng quay chậm (canvas).
- `fg: [TNF.frame({color}), TNF.topBar({brand, steps:8}), TNF.bottomBar({brand})]`: khung viền 4 góc tự vẽ; thanh logo trắng + tiến trình 8 ô (theo tiến độ toàn video); thanh vàng "HOTLINE <số>" + website.
- Truyền `width/height` cho các lớp nếu khác 1080x1920.

**Brand**: `TNF.brand(window.TNF_BRAND)` chuẩn hóa `{name, tagline, logo, colors:{primary,accent,bg,text}, fonts:{heading,body}, hotline, website}`. Trong CSS dùng biến `var(--c-primary) --c-accent --c-bg --c-text --f-heading --f-body`.

**Video tư liệu** (ví dụ cabin quay trên bệ):
```js
mount(c){ const v = TNF.el('video', {src:'assets/cabin-turntable.mp4', style:{position:'absolute',left:'140px',top:'600px',width:'800px'}});
          c.root.append(v); c.state.vid = TNF.video(v, {start: 9, loop: true}); },
render(c){ return c.state.vid.seek(c.t); }   // trả Promise để renderer chờ 'seeked'
```
`TNF.video(el,{start, loop, rate})` ép muted/paused; `currentTime = (t - start) * rate` (lặp nếu `loop`). Gọi trong `mount`.

## 6. Quy trình gợi ý
1. Đọc `project.json`, `brand.json`, `template/`. Viết `brand.js` từ `brand.json`.
2. Một tệp cảnh cho mỗi phân cảnh, khớp `start/end` trong `project.json`; ghép trong `index.html`.
3. Phân cảnh mới vào bằng `glitch`/`slide`; ô/khối vào so le (stagger 0.1..0.15 s); chữ tiêu đề dùng `outBack`/`outCubic`.
4. Kiểm bằng `?selftest=` khi nghi ngờ không xác định.
