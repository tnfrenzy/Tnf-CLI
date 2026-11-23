# HANDOVER — Brief khởi động phiên mới (cập nhật 2026-11-23)

Đọc [`AGENTS.md`](../AGENTS.md) và tệp này **trước**. Mục tiêu: bất kỳ phiên mới nào đều có thể làm tiếp ngay mà **không cần đọc lại toàn bộ mã nguồn**.

## 1. Dự án hiện tại (TNF CLI)
- **Tên dự án:** **TNF CLI** (đổi tên từ *TNF Claude Controller*; giữ nguyên `AppId` và `%LOCALAPPDATA%\TNF\Controller` của Inno Setup để cài đè không mất dữ liệu).
- **Công nghệ:** Windows local web app (`127.0.0.1:4800`), Node.js ≥ 22.5, TypeScript (0 lỗi, không `any` ở mã lõi/UI mới), SQLite (`node:sqlite`), React 19 + Vite 8, Vitest 5.
- **CLI điều phối:** **[Claude Code CLI](https://docs.claude.com/en/docs/claude-code)** (`claude -p`), chạy trực tiếp binary gốc cục bộ cho nhu cầu cá nhân:
  - Quản lý nhiều tài khoản Claude Code cô lập qua `CLAUDE_CONFIG_DIR` (`data/cli-profiles/<id>`).
  - Lưu cooldown hạn mức bền trong `cli-accounts.json` và tự chuyển dự phòng sang tài khoản Claude khác khi chạm hạn mức (`autoFailover`).
  - Phân bổ tài khoản & model theo từng vai (Coding, Ý tưởng, Xưởng Video AI, Xưởng 3D).
  - *(Đã gỡ hẳn `antigravity` / `codex` và lập trình đa pha trộn CLI theo chính sách tháng 11/2026 để tuân thủ điều khoản sử dụng và bảo vệ tài khoản người dùng.)*

## 2. Giao diện & Trải nghiệm (UI/UX)
- **Giao diện một màn hình (`ui/src/App.tsx`):** bảng trái (`LeftPanel.tsx`) + cảnh thành phố (`CityScene.tsx` có ánh sáng tầng đang hoạt động, sương chân trời) + Văn phòng 2.5D isometric (`OfficeScene25D.tsx`, `IsoPerson.tsx` có nhịp thở/chớp mắt/gõ phím lệch pha riêng từng nhân vật, ánh sáng màn hình, bóng đổ 2 lớp).
- **Song ngữ hoàn chỉnh:** `ui/src/i18n/vi.ts` và `ui/src/i18n/en.ts` tách riêng, `ui/src/i18n.ts` làm facade mỏng; `tests/ui/english-ui-no-vietnamese.test.ts` chặn lẫn tiếng Việt trong giao diện tiếng Anh.
- **Cài đặt gọn cho người mới (`SettingsPanel.tsx`, `CliAccountsSection.tsx`, `TuningSection.tsx`, `CommandPage.tsx`):**
  - Bảng phân vai 3 cột (`Vai trò | Tài khoản CLI | Model`) chia 4 nhóm (*Lập trình*, *Ý tưởng*, *Xưởng Video AI* đủ `video-director` + `video-editor`, *Xưởng 3D*).
  - Card cấu hình AI mặc định cho Xưởng Video trong cả *Cài đặt → Điều chỉnh* và *Cài đặt Xưởng Video*.
  - Modal Lệnh gọn gàng (bảng model từng vai 2 cột, bỏ 2 mục nâng cao gây rối).

## 3. Trạng thái kiểm chứng (2026-11-23)
- `npm run typecheck`, `npm run test:fast`, `npm run build:ui`, `npm run privacy:scan`: PASS.
- GitHub Actions CI (`.github/workflows/ci.yml`): dùng `npm ci --legacy-peer-deps`, chuẩn hóa đường dẫn Windows 8.3 trong `validateRepo`.
- Bộ cài Windows: `installer/setup.iss` tự xóa shortcut cũ `TNF Claude Controller*.lnk` và khóa Registry cũ khi nâng cấp.

## 4. Việc mở / Gợi ý cho phiên tiếp theo
1. Nếu sau này muốn hỗ trợ thêm Gemini / OpenAI một cách **tuân thủ 100% ToS**, chỉ tích hợp qua **API Key chính thống** (`GEMINI_API_KEY` / `OPENAI_API_KEY` / Vertex AI), tuyệt đối không bọc CLI gói cá nhân.
2. Tối ưu thêm hiệu ứng sống động Văn phòng 2.5D (di chuyển ngắn giữa các điểm, bong bóng bàn giao giữa các vai).
3. Dọn nợ kỹ thuật cũ (ưu tiên thấp): quy vai chính xác cho `vcs.commit`; kiểm AR/USDZ Xưởng 3D trên điện thoại thật.
