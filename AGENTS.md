# AGENTS.md — Hướng dẫn cho AI Agent

> Đây là tệp hướng dẫn gốc chính thức của dự án **TNF CLI** (`D:\tnf-claude-controller`), dùng chung cho các phiên làm việc mới.

**Đọc đầu phiên:** đọc tệp này → `docs/HANDOVER.md` (tóm tắt trạng thái, bản đồ mã, việc mở dưới 10k token) → mục đầu của `docs/PROGRESS.md` (nhật ký mới nhất). Không cần đọc lại toàn bộ mã nguồn hay nhật ký cũ trong `docs/archive/` trừ khi nhiệm vụ yêu cầu.

## 1. Dự án là gì
**TNF CLI** là app web chạy **cục bộ trên Windows** (`127.0.0.1:4800`, Node.js ≥ 22.5 + TypeScript + SQLite + React/Vite), điều phối **[Claude Code CLI](https://docs.claude.com/en/docs/claude-code)** (`claude -p`) trên máy cá nhân bằng gói thuê bao claude.ai (không dùng API Key). Hỗ trợ cô lập nhiều tài khoản Claude qua `CLAUDE_CONFIG_DIR` và tự chuyển dự phòng khi chạm hạn mức.

*(Lưu ý chính sách 11/2026: không bọc/điều phối `agy` hoặc `codex` bằng gói cá nhân bên trong app bên thứ ba để tuân thủ điều khoản sử dụng và bảo vệ tài khoản người dùng.)*

Mã lập trình được viết trong **git worktree riêng** (`<worktreesDir>/<run-id>`, nhánh `tnf/<run-id>`) để repo chính luôn sạch. UI gồm cảnh thành phố một màn hình (`CityScene.tsx`), văn phòng 2.5D isometric (`OfficeScene25D.tsx`, `IsoPerson.tsx`), hàng đợi ý tưởng → task, Xưởng 3D (CadQuery + Blender), Xưởng Video AI (demo), và Cài đặt Tài khoản CLI.

## 2. Ngôn ngữ & Quy tắc giao diện song ngữ
- Giao tiếp với người dùng, UI, thông báo lỗi hiển thị, báo cáo agent: **tiếng Việt** (mặc định).
- Mã nguồn, tên biến, tên tệp, commit message: **tiếng Anh**.
- **Quy tắc cứng song ngữ UI:** mọi chuỗi hiển thị phải có đồng thời trong `ui/src/i18n/vi.ts` và `ui/src/i18n/en.ts` (cùng bộ khóa, facade tại `ui/src/i18n.ts`), hoặc dùng `pick(vi, en)` từ `ui/src/lib/lang.ts`. Giao diện tiếng Anh không được lẫn tiếng Việt (`tests/ui/english-ui-no-vietnamese.test.ts`).

## 3. Quy tắc cứng (bắt buộc tuân thủ)
1. **Chế độ thuê bao Claude Code CLI:** xóa `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`; chạy `claude auth status`; cấm `--bare` và `--dangerously-skip-permissions`. Không trích xuất hay proxy OAuth token.
2. **Spawn không qua shell** (`shell: false`): prompt truyền qua stdin hoặc file tạm; dùng file cho `--agents`, `--append-system-prompt-file`, `--settings`, `--mcp-config`.
3. **Bảo mật local:** server chỉ bind `127.0.0.1`; mọi API/WS cần header `X-Controller-Token` (hoặc subprotocol `tnf-token.<token>`) và kiểm `Origin`/`Host`.
4. **Không đụng cấu hình toàn cục:** không sửa `~/.claude/settings.json`, không cài hook toàn cục, không `npm/pip/uv install -g` khi chưa hỏi người dùng.
5. **Riêng tư trước khi công khai:** luôn chạy `npm run privacy:scan` (phải ra `Sạch`). Không bao giờ commit `data/`, `controller.token`, `.privacy-denylist`, ảnh chụp thật chứa dữ liệu cá nhân, hay `allowedOrigins` thật.
6. **Phát hành công khai:** dùng `npm run publish:snapshot` (tạo nhánh `public-snapshot` 1 commit sạch lịch sử). Không tự động `--push` lên remote nếu người dùng chưa yêu cầu rõ.
7. **Tệp `.ps1` / `.iss` có tiếng Việt** phải giữ **UTF-8 with BOM** để PowerShell 5.1 không lỗi cú pháp.
8. **Chất lượng code:** không dùng `any` mới trong TypeScript; cập nhật `docs/PROGRESS.md` kèm bằng chứng chạy thật sau mỗi đợt thay đổi lớn.

## 4. Lệnh thường dùng
```powershell
npm run typecheck                 # Kiểm tra TypeScript cả backend + UI
npm run test:fast                 # Bộ test nhanh (< 20s): accounts, i18n, stream, release
npm test                          # Toàn bộ test suite (không gọi CLI thật)
npm run build:ui                  # Build giao diện React/Vite
npm run privacy:scan              # Quét lộ dữ liệu cá nhân / khóa bí mật
.\scripts\start.ps1               # Chạy thật
.\scripts\start.ps1 -Demo         # Chạy offline với fake-claude.mjs
npm run tnf -- accounts list      # Quản lý tài khoản Claude Code CLI
npm run package                   # Đóng gói build/app/
npm run installer                 # Tạo bộ cài build/TNF-CLI-Setup-<version>.exe (Inno Setup 6)
```

## 5. Bản đồ mã nguồn cốt lõi
- `src/core/shared-types.ts`: kiểu dùng chung giữa backend và UI (`CliProviderId`, `CliAccountPublic`, `RoleAccountMap`, ...).
- `src/core/run/providers/`: lớp trừu tượng `CliProvider`, `registry.ts`, `claude-provider.ts`, `model-distribution.ts`.
- `src/core/run/`: `cli-accounts.ts` (`CliAccountStore`, cô lập `CLAUDE_CONFIG_DIR`, cooldown bền & failover), `run-manager.ts`, `run-store.ts` (SQLite `node:sqlite`), `billing-guard.ts`, `stream-parser.ts`, `events.ts`, `grants.ts`.
- `src/core/{app,git,queue,ideas,mcp,preview,roles,usage,design3d,release,skill-workshop,workshop3d}/`: các phân hệ lõi.
- `src/server/`: `index.ts`, `http.ts`, `auth.ts`, `routes/cli-accounts.ts`.
- `src/cli.ts`: lệnh `tnf` (`run`, `resume`, `serve`, `accounts`, `projects`, `list`, `show`, `status`, `open`, `w3d`).
- `ui/src/`: `App.tsx`, `api.ts`, `types.ts`, `i18n.ts` (facade cho `i18n/vi.ts` + `i18n/en.ts`), `components/settings/CliAccountsSection.tsx`, `office/` (`CityScene.tsx`, `OfficeScene25D.tsx`, `iso/IsoPerson.tsx`).
- `.github/workflows/ci.yml`: CI tự động (`typecheck`, `test:fast`, `build:ui`, `privacy:scan`).
