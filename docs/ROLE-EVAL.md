# Chấm vai trong Thư viện bằng ca thử

> **Lưu ý:** đây là **đặc tả thiết kế**. Mã triển khai (route, bộ chạy, giao diện) có thể chưa có đủ tại thời điểm đọc; hãy đối chiếu với mã nguồn trước khi dựa vào từng chi tiết.

## Mục đích

Cho phép người dùng gắn một số ca thử vào một vai tự tạo trong Thư viện, rồi chạy thật vai đó để xem nó có đáp ứng các tiêu chí cứng hay không. Kết quả là điểm 0-100 theo từng phiên bản của vai, để so sánh trước và sau khi sửa mô tả, prompt, công cụ hoặc mô hình.

Chấm điểm chạy thật qua `claude -p` ở chế độ chỉ đọc, không gọi AI để chấm.

## Gắn ca thử (1-5 ca)

Mỗi vai gắn từ 1 đến 5 ca. Mỗi ca có:

- `id`: khớp `[a-z0-9-]{1,40}`.
- `title`: tối đa 80 ký tự.
- `prompt`: 1 đến 2000 ký tự, là yêu cầu giao cho vai.
- `checks`: 1 đến 8 tiêu chí (xem mục sau).
- `passRatio`: từ 0 đến 1, mặc định 0.5.

`passRatio` của ca thử là một khái niệm riêng, không liên quan đến `passScore` của rubric trong Xưởng Skill.

## Các loại tiêu chí

Tất cả đều là tiêu chí cứng, kiểm bằng so khớp trên đầu ra:

- `contains`: đầu ra phải chứa chuỗi cho trước.
- `not-contains`: đầu ra không được chứa chuỗi cho trước.
- `regex`: đầu ra khớp mẫu; `pattern` tối đa 200 ký tự, `flags` tùy chọn.
- `max-length`: độ dài đầu ra không vượt giới hạn.
- `min-length`: độ dài đầu ra không thấp hơn giới hạn.
- `no-tool`: mảng tên công cụ bị cấm; đạt khi vai không gọi công cụ nào trong danh sách đó. Chấm theo tên `tool_use` trong luồng đầu ra (stream) của lần chạy.

Không có loại tiêu chí nào gọi AI. Loại `no-tool` không thuộc `rubric.ts`, nó nằm riêng trong bộ chấm vai.

Ý tưởng về các loại assertion tham khảo promptfoo (giấy phép MIT), nhưng dự án không dùng thư viện đó; toàn bộ phần chấm tự viết.

## Ngưỡng mềm và repeats

Mỗi ca có thể chạy lặp `repeats` lần, từ 1 đến 3, vì đầu ra của mô hình không cố định. Một lần chạy "đạt" khi mọi tiêu chí của ca đều đạt. Ca đạt khi `passes / attempts >= passRatio`. Đó là ngưỡng mềm: ca vẫn đạt dù một vài lần chạy trượt, miễn tỉ lệ đủ.

Ví dụ: `passRatio` 0.5 và `repeats` 3 thì cần ít nhất 2 trên 3 lần đạt.

## Điểm theo phiên bản vai

Mỗi kết quả gắn với `roleVersionHash`: 12 ký tự hex đầu của sha256 trên mô tả, prompt, danh sách công cụ đã sắp xếp và mô hình của vai. Sửa bất kỳ phần nào trong số đó thì hash đổi.

- Điểm từ 0 đến 100.
- Chỉ so sánh điểm trong cùng một hash; điểm của hash khác là của phiên bản khác của vai.
- Lưu tại `<dataDir>/library/role-evals/<roleId>.json`, ghi nguyên tử (ghi tệp tạm rồi đổi tên), giữ tối đa 50 kết quả gần nhất.

## Chi phí hạn mức

Số lần chạy thật = số ca x số lần lặp. Tối đa 5 ca x 3 lần = 15 lần chạy cho một lượt chấm, tức tối đa 15 lần gọi `claude -p` tiêu tốn hạn mức gói thuê bao. Mỗi lần chạy có `maxBudgetUsd` mặc định 0.5. Hãy bắt đầu với `repeats` bằng 1 khi chỉ muốn thử nhanh.

## Mô hình bảo mật

Vai được chấm có thể do người khác viết, nên coi cả prompt lẫn đầu ra là không tin cậy.

- Chỉ cấp ba công cụ đọc: Read, Grep, Glob. Không có công cụ ghi hay thực thi lệnh.
- Không cấp thư mục ghi và không cấp thư mục của kho mã.
- Thư mục làm việc (cwd) là một thư mục run mới, rỗng, tạo riêng cho từng lần chạy.
- Không dùng bất kỳ cờ nào để bỏ qua kiểm tra quyền; quyền chỉ đi qua cơ chế cho phép công cụ thông thường.
- Biến môi trường chứa khóa API bị gỡ khỏi tiến trình con.
- Đầu ra là dữ liệu không tin cậy: chỉ dùng để so khớp, giao diện hiển thị dưới dạng văn bản thuần, và bị cắt ở 200 KB.

## Xóa vai

Khi xóa một vai tự tạo, tệp ca thử `<dataDir>/library/role-evals/<roleId>.json` cũng bị xóa. Tính năng chỉ áp dụng cho vai tự tạo, không áp dụng cho vai có sẵn.

## Khác biệt với Xưởng Skill

- Xưởng Skill dùng rubric có trọng số và `passScore`, có thể có tiêu chí do AI chấm, và chấm skill hoặc prompt.
- Chấm vai chấm vai trong Thư viện, tiêu chí cứng, ngưỡng mềm `passRatio`, chạy thật qua `claude -p` chỉ đọc.
- Tính năng này không thay đổi hành vi của Xưởng Skill.

## API

- `GET /api/library/roles/:id/evals`: đọc ca thử và kết quả đã lưu.
- `PUT /api/library/roles/:id/evals`: ghi bộ ca thử (1-5 ca).
- `POST /api/library/roles/:id/evals/run`: bắt đầu chấm; body `{ "repeats": 1 | 2 | 3 }` (tùy chọn). Trả 202 khi nhận, 409 khi vai đang được chấm, 400 khi dữ liệu không hợp lệ.
- `POST /api/library/roles/:id/evals/cancel`: hủy lượt chấm đang chạy.
- `DELETE /api/library/roles/:id`: xóa vai, kèm xóa ca thử.
