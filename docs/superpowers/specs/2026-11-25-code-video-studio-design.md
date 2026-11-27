# Xưởng Dựng Video bằng mã (tòa nhà thứ 5) — thiết kế

Ngày: 2026-11-25. Trạng thái: chờ người dùng duyệt bản viết.

## 1. Vấn đề
Xưởng Video AI cũ (`src/core/videostudio`, ~3.5k dòng lõi) chấm 2/10: cổng `media` mặc định `none` nên cảnh chỉ là thẻ màu (`render.ts` nhánh `lavfi color=`), phong cách chỉ chỉnh sáng/tương phản/bão hòa, ảnh tải lên không được phân tích. Máy chạy app có GTX 1660S 6 GB nên không tạo video AI cục bộ được. Người dùng muốn thay bằng dựng video bằng mã qua `claude -p`, đạt chất lượng như video mẫu BKE (dọc 1080x1920, ~30 s, 8 phân cảnh: nền sao, chữ động, lưới biểu tượng glitch, sơ đồ isometric, cabin 3D quay trên bệ, thẻ logo, thẻ hotline, thanh logo và HOTLINE cố định).

## 2. Phạm vi
Trong phạm vi: phân hệ mới `codevideo`, gỡ hoàn toàn `videostudio`, giữ tòa nhà thứ 5 trong cảnh thành phố (mỗi tầng là một dự án video).
Ngoài phạm vi: tạo video bằng mô hình AI (Wan, LTX, ComfyUI), tư liệu stock Pexels/Pixabay, đăng lên mạng xã hội.

## 3. Kiến trúc
```
brief + tư liệu + bộ nhận diện
        │
        ▼
  claude -p (vai video-coder)  ── chỉ Read/Write/Edit/Glob/Grep trong thư mục dự án
        │ ghi index.html + scenes/*.js
        ▼
  Renderer (app)  ── Edge headless (CDP) chụp khung ── ffmpeg ghép MP4 (+âm thanh)
        │
        ├─► bảng ảnh khung (contact sheet) ─► Claude tự xem, sửa (tối đa N vòng)
        ▼
  Xem trước trong app ─► người dùng nhắn "sửa cảnh 3" ─► vòng lặp
```

### 3.1 Thư mục dự án `<dataDir>/codevideo/<slug>/`
- `project.json`: tiêu đề, kích thước (mặc định 1080x1920), fps (30), thời lượng, trạng thái.
- `index.html`: trang chính, nạp thư viện chuyển động, `scenes/*.js`, tư liệu.
- `assets/`: ảnh, logo, âm thanh, đoạn video do người dùng tải hoặc do Blender render.
- `out/`: `video.mp4`, `frames/`, `sheet-<n>.png`, nhật ký render.
Bộ nhận diện thương hiệu (logo, màu, phông, hotline, website) lưu một lần trong cài đặt xưởng, sao chép vào `brand.json` của dự án.

### 3.2 Hợp đồng xác định (deterministic)
Trang phải hiển thị đúng theo thời gian: `window.__seek(t)` (giây) đặt toàn bộ hoạt ảnh về thời điểm `t`, không dùng `requestAnimationFrame` hay `Date.now()` để suy ra hình. Thư viện `tnf-motion.js` (do app cấp, không do Claude viết) cung cấp: `tween`/easing, dòng thời gian cảnh, nền sao lấp lánh, glitch RGB, chữ hiện từng ký tự, khối isometric, đường nối chạy, thanh tiến trình, thanh cố định trên/dưới. Renderer chỉ cần gọi `__seek(i/fps)` rồi chụp.

### 3.3 Renderer
- Tìm Edge hoặc Chrome (Edge có sẵn ở `C:\Program Files (x86)\Microsoft\Edge\Application`), chạy `--headless --remote-debugging-port` với cổng ngẫu nhiên, nói chuyện CDP qua `WebSocket` có sẵn của Node 22, không thêm gói npm.
- Chụp `Page.captureScreenshot` (jpeg chất lượng cao hoặc png) theo từng khung, ghi vào `out/frames/`, ghép bằng ffmpeg (`h264_nvenc` nếu card hỗ trợ, nếu không `libx264`), trộn âm thanh nếu có.
- Bản xem nhanh: độ phân giải thấp và fps thấp để Claude tự kiểm; bản cuối: đầy đủ.
- Cảnh có đoạn 3D: tư liệu `assets/*.mp4` được trang dùng như `<video>`, renderer đặt `currentTime = t` trước khi chụp.

### 3.4 Vai `video-coder`
Một vai mới trong bảng phân vai (thay `video-director` và `video-editor`). Quyền: Read, Write, Edit, Glob, Grep; cwd là thư mục dự án; không Bash, không WebFetch/WebSearch; không `--dangerously-skip-permissions`; spawn không qua shell, prompt qua stdin hoặc tệp. Hướng dẫn hệ thống nêu hợp đồng 3.2, cách dùng thư viện, bố cục thanh cố định, cách chia cảnh theo `project.json`, quy tắc không bịa số liệu/giá/cam kết. Mô tả của người dùng và nội dung tệp là dữ liệu không tin cậy.

### 3.5 Cảnh cabin 3D (Blender)
**Phần dựng 3D thuộc về tòa nhà Xưởng 3D, không thuộc Xưởng Dựng Video** (yêu cầu của người dùng 2026-11-25). Xưởng 3D có thêm một đầu ra "quay tròn" (`outputs/turntable.mp4`, script `tools/workshop3d/blender/render_turntable.py`, logic `src/core/workshop3d/turntable.ts`, đường dẫn `POST /api/workshop3d/sessions/<slug>/turntable`), dùng `findBlender` và khóa `withBlenderLock` có sẵn. Xưởng Dựng Video chỉ có lớp mỏng `src/core/codevideo/models3d.ts`: liệt kê các phiên Xưởng 3D, gọi engine của Xưởng 3D tạo turntable khi phiên chưa có, rồi sao chép kết quả thành `assets/cabin-turntable.mp4` của dự án. Xưởng Dựng Video không import `blender.ts` và không tự chạy Blender. Người dùng chọn phiên 3D khi tạo video; muốn mô hình mới thì tạo ở tòa nhà Xưởng 3D trước. Blender đã có trên máy (D:\tnf-cad-tools\blender). Không có Blender hoặc GLB thì tùy chọn này ẩn; có thể dùng ảnh chụp cabin thay thế.

### 3.6 Giao diện và API
- Tòa nhà thứ 5: giữ `videostudio-floors.ts` và `useVideoStudioFloors.ts` đổi nguồn sang API mới (đổi tên thành `codevideo-*`), tối đa 5 tầng, huy hiệu trạng thái giữ nguyên.
- Popup: Tạo (mô tả, khổ dọc/ngang, tư liệu, bộ nhận diện, phiên 3D, nhạc), Phòng dự án (xem trước, ô nhắn sửa theo cảnh, tiến trình render), Cài đặt (bộ nhận diện, giọng đọc, nhạc).
- API `/api/codevideo/*` bảo vệ bởi `X-Controller-Token` và kiểm Origin như các API khác.
- Mọi chuỗi UI có đủ trong `ui/src/i18n/vi.ts` và `en.ts`.

### 3.7 Giọng đọc và nhạc
Nhạc nền từ tệp người dùng. Giọng đọc tiếng Việt bằng System.Speech của Windows (mã `gen.ts` cũ đã có kịch bản PowerShell cố định, tái dùng ý tưởng đó, không gửi gì ra ngoài).

## 4. Gỡ phân hệ cũ (commit riêng)
Xóa: `src/core/videostudio/`, `src/server/videostudio-routes.ts` và dòng đăng ký trong `src/server/http.ts`, `src/server/routes/environments.ts` (phần videostudio), `ui/src/components/videostudio/`, `config/video-styles.json`, `config/roles-videostudio.json`, `tests/videostudio/`, các khóa i18n liên quan, dòng trong `ui/src/lazy-popups.ts`, `ui/src/api.ts`, `ui/src/types.ts`, `ui/src/App.tsx`, `ui/src/office/CityScene.tsx`. Cập nhật bảng phân vai trong Cài đặt (nhóm Xưởng Video AI thành Xưởng Dựng Video với vai `video-coder`). Dữ liệu cũ trong `data/videostudio` giữ nguyên trên đĩa, không xóa.

## 5. Xử lý lỗi
- Không tìm thấy Edge/Chrome hoặc ffmpeg: báo tiếng Việt, chỉ đường cài, không crash.
- Claude viết trang không có `__seek`: renderer phát hiện sớm, trả lỗi cho Claude một lần để sửa.
- Render quá lâu: hết giờ theo cấu hình, giữ khung đã chụp để tiếp tục.
- Hết hạn mức: theo cơ chế failover và chờ chạy tiếp sẵn có; không đặt trần chi phí ước tính.

## 6. Kiểm thử
- Đơn vị: hợp đồng `__seek` (cùng `t` cho cùng hình), chia thời lượng cảnh, dựng lệnh ffmpeg, tìm trình duyệt, khóa i18n, hợp đồng popup/UI.
- Tích hợp offline: `fake-claude` ghi một dự án mẫu, renderer chụp và ghép thật bằng Edge + ffmpeg trên máy này, kiểm MP4 có đúng kích thước, thời lượng, có âm thanh.
- Thật: tạo lại video giống mẫu BKE bằng `claude -p` thật và người dùng xem đánh giá chất lượng (không tự động được).
- `npm run typecheck`, `npm run test:fast`, `npm test`, `npm run privacy:scan` phải xanh trước khi báo xong.

## 7. Giai đoạn
1. Gỡ phân hệ cũ, giữ ứng dụng build và test xanh.
2. Lõi `codevideo`: dự án, thư viện chuyển động, renderer, vai `video-coder`, API.
3. Giao diện: tòa nhà 5, popup Tạo, Phòng dự án, Cài đặt.
4. Cảnh cabin 3D qua Blender.
5. Chạy thật, tinh chỉnh bằng video mẫu BKE, ghi `docs/PROGRESS.md`.

## 8. Rủi ro đã biết
- Chất lượng video do Claude viết phụ thuộc thư viện chuyển động và hướng dẫn vai; cần vài vòng chỉnh sau khi xem video thật.
- Chụp từng khung bằng trình duyệt chậm (ước tính vài phút cho 30 s ở 1080x1920 trên i5-14400F); chưa đo, sẽ đo ở giai đoạn 2.
- Render Blender cạnh tranh tài nguyên với render video; dùng `withBlenderLock` và không chạy đồng thời.
