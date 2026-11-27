# Chuẩn bị worktree trước khi chạy agent

## Mục lục
1. Mục đích
2. Khai báo glob và Cài đặt
3. API
4. Thứ tự chạy
5. An toàn
6. Giới hạn
7. Đọc kết quả
8. Ghi chú trạng thái

## 1. Mục đích
Mỗi run của agent chạy trong một git worktree riêng. Worktree mới chỉ chứa file được git theo dõi, nên các file bị `.gitignore` (ví dụ `.env.local`, `config/*.local.json`) không có mặt và agent hay thiếu cấu hình cục bộ. Tính năng này cho phép mỗi dự án khai báo:

- danh sách mẫu glob của file cục bộ cần chép từ thư mục dự án sang worktree;
- một lệnh setup chạy trong worktree trước khi agent bắt đầu;
- thời gian chờ tối đa cho lệnh setup.

Mặc định không chép gì và không chạy lệnh nào.

## 2. Khai báo glob và Cài đặt
Trong Cài đặt của dự án, mục chuẩn bị worktree có ba trường.

- **Mẫu tệp (`files`)**: mỗi dòng một glob tương đối với gốc dự án, ví dụ `.env.local` hoặc `config/*.local.json`.
- **Lệnh setup (`command`)**: một lệnh duy nhất, phải khớp tiền tố trong `allowed_commands` của môi trường. Lệnh chạy với `shell:false`, nghĩa là không có pipe, `&&` hay biến shell.
- **Thời gian chờ (`timeoutSec`)**: mặc định 180 giây, cho phép từ 10 đến 900 giây.

## 3. API
Route nằm ở `src/server/routes/grants.ts`, validator ở `src/core/git/worktree-setup.ts`.

`GET /api/projects/:name/worktree-setup` trả về `{setup, allowedCommands}`. Trong đó `setup` có các trường `files`, `command`, `timeoutSec`; `allowedCommands` là danh sách tiền tố được phép để giao diện gợi ý. Trả 404 khi dự án không có môi trường.

`PUT /api/projects/:name/worktree-setup` nhận `{setup}` với cùng các trường `files`, `command`, `timeoutSec`.

- Thành công: 200 `{setup}` (bản đã chuẩn hóa).
- Sai dữ liệu: 400 `{error:"bad_request", message}`, `message` bằng tiếng Việt, ví dụ "Tối đa 20 mẫu tệp." hoặc "Thời gian chờ phải từ 10 đến 900 giây.".

## 4. Thứ tự chạy
Khi bắt đầu một run, các bước diễn ra theo thứ tự sau.

1. Tạo worktree từ nhánh của dự án.
2. Liên kết hoặc chuẩn bị node_modules cho worktree.
3. Chép file khớp glob (chỉ file bị .gitignore) vào worktree.
4. Quét ngữ cảnh dự án, bỏ qua các file vừa chép để không đưa nội dung chúng vào ngữ cảnh.
5. Tạo bản ghi run (createRun).
6. Chạy lệnh setup trong worktree.
7. Khởi động agent/runner.

Lỗi ở bước chép file hoặc lệnh setup chỉ sinh notice cảnh báo, không làm hỏng run.

## 5. An toàn
- Mặc định không chép: danh sách mẫu rỗng thì không có gì được chép.
- Chặn đường dẫn tuyệt đối và `..` trong mẫu; mẫu như vậy bị từ chối ở validator.
- Chỉ chép file thực sự bị `.gitignore`; file được git theo dõi đã có sẵn trong worktree.
- Lệnh setup chạy với `shell:false` và phải khớp `allowed_commands`.
- Timeout mặc định 180 giây, quá hạn thì lệnh bị dừng.
- Không ghi nội dung file đã chép vào log; chỉ ghi tên và kích thước.
- Agent vẫn đọc được các file đã chép, vì vậy không đặt bí mật sản xuất vào đó. Chỉ dùng giá trị cho môi trường phát triển.

## 6. Giới hạn
Theo thiết kế, phần chép file và notice chưa nằm trong src; các con số dưới đây là hợp đồng thiết kế, trừ khi ghi khác.

- Tối đa 20 mẫu tệp (đã có trong validator).
- Tối đa 50 file được chép mỗi run (theo thiết kế, chưa nằm trong src).
- Tối đa 5 MB mỗi file (theo thiết kế, chưa nằm trong src).
- Tối đa 20 MB tổng cộng (theo thiết kế, chưa nằm trong src).
- Timeout 180 giây mặc định, từ 10 đến 900 giây (đã có trong validator).
- Đuôi log của lệnh setup giữ 4000 byte (theo thiết kế, chưa nằm trong src).

## 7. Đọc kết quả
Kết quả hiện trên Timeline dưới dạng notice (theo thiết kế, chưa nằm trong src).

- `worktree.setup`: setup hoàn tất, kèm số file đã chép và trạng thái lệnh.
- `worktree.setup.error`: có lỗi ở bước chép hoặc lệnh setup; run vẫn tiếp tục.

Chi tiết nằm trong tệp `worktree-setup.txt` trong thư mục của run (`runDir/worktree-setup.txt`): danh sách file đã chép, mã thoát và đuôi log 4000 byte của lệnh setup. Tệp không chứa nội dung file đã chép.

## 8. Ghi chú trạng thái
Hiện tại cấu hình, validator và API (mục 2 và 3) đã có trong src. Phần chép file, lệnh setup trong luồng run và notice Timeline chưa có trong src; tài liệu này là hợp đồng thiết kế cho phần đó theo lệnh anh em. Khi triển khai xong, cập nhật lại mục này.
