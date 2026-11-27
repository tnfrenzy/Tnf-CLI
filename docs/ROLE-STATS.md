# Thống kê vai (role stats)

Đặc tả theo hợp đồng của ý tưởng; mã do các lệnh khác cung cấp.

Tài liệu mô tả bảng thống kê mức dùng của từng vai (agent role), trả qua `GET /api/library/role-stats`. Mọi tên hàm, bảng hay tệp mã chưa có trong nhánh lúc viết đều là thiết kế; tài liệu này không trích mã nguồn.

Mục lục: 1. Mục đích; 2. Nguồn số liệu; 3. Ý nghĩa các cột; 4. Cách ghép nhóm; 5. Quy tắc gợi ý; 6. Giới hạn tham số; 7. Giới hạn đã biết; 8. Bảo mật.

## 1. Mục đích

Thư viện vai bị giới hạn ở 30 vai. Khi đầy, người dùng phải chọn giữ, sửa hay xóa từng vai. Bảng thống kê cho biết vai nào được gọi nhiều, vai nào ít dùng, hay bị chặn quyền, hay cho kết quả không đạt, để quyết định có căn cứ thay vì đoán. Bảng chỉ gợi ý; không bao giờ tự xóa hay tự sửa vai.

## 2. Nguồn số liệu

Ba nguồn, đều đã lưu cục bộ cùng các run:

- **agents** của từng run: danh sách vai đã được gọi trong run, kèm lượng token (`usage.input` và `usage.output`, hoặc `progress.total_tokens`) và thời gian (`progress.duration_ms`).
- **verdicts** của run: kết luận của các vai kiểm duyệt. Verdict đạt: APPROVED, APPROVED_WITH_CONCERNS, PASS, PASS_ENV. Verdict không đạt: NEEDS_REVISION, BLOCKED, FAIL.
- **sự kiện từ chối quyền** (`permission.denied`): mỗi lần một vai bị chặn một thao tác, kèm `agent_id`.

Không có nguồn nào khác; không gọi mạng, không đọc tệp ngoài kho lưu run.

## 3. Ý nghĩa các cột

Mỗi hàng ứng với một vai, theo thứ tự cột:

1. `role`: tên vai.
2. `group`: nhóm của vai (xem mục 4).
3. `calls`: số lần vai được gọi trong cửa sổ thời gian.
4. `runs`: số run có vai này.
5. `tokens`: tổng `usage.input` + `usage.output`; nếu bằng 0 thì dùng `progress.total_tokens`.
6. `durationMs`: tổng `progress.duration_ms`.
7. `permissionDenials`: số lần vai bị từ chối quyền.
8. `runsWithVerdict`: số run có vai này và có verdict.
9. `passRuns`: số run trong đó verdict thuộc nhóm đạt.
10. `passRate`: `passRuns` / `runsWithVerdict`, trong khoảng 0..1; `null` khi `runsWithVerdict` = 0.
11. `lastUsedAt`: `created_at` lớn nhất của các run có vai; `null` khi `calls` = 0.

Ngoài các hàng, kết quả có thêm bốn trường tổng:

- `runsScanned`: số run đã quét.
- `runsWithoutAgents`: số run không có agents (thường là run cũ).
- `coordinatorDenials`: số lần từ chối quyền của vai điều phối, tính riêng, không tạo hàng.
- `truncated`: `true` khi số run vượt trần và bị cắt bớt.

## 4. Cách ghép nhóm

Có năm nhóm: coding, thư viện, cad3d, khác, không xác định (`group='unknown'`).

Nguồn nhóm: `config/roles-coding.json` (coding), `config/roles-design3d.json` (cad3d) và id các vai trong thư viện (thư viện). Thứ tự ưu tiên khi một tên khớp nhiều nguồn: thư viện, rồi cad3d, rồi coding.

- Vai có tên hợp lệ nhưng không khớp nguồn nào: nhóm khác (`other`).
- Vai rỗng, `subagent` hoặc `unknown`: nhóm không xác định, `group='unknown'`.

## 5. Quy tắc gợi ý

Mỗi hàng có thể kèm gợi ý; hàng `unknown` bị bỏ qua. Ngưỡng mặc định:

| Gợi ý | Điều kiện | Tham số |
|---|---|---|
| `unused` | vai nhóm thư viện có `calls` = 0 | không có |
| `rare` | 0 < `calls` <= 2 | `rareMaxCalls` = 2 |
| `denied` | `permissionDenials` >= 2 và `permissionDenials` / `calls` >= 0.3 | `deniedMinRatio` = 0.3 |
| `low_pass` | `runsWithVerdict` >= 3 và `passRate` <= 0.5 | `minVerdictRuns` = 3, `lowPassMax` = 0.5 |

Gợi ý chỉ để người dùng cân nhắc giữ, sửa hay xóa; một vai có thể có nhiều gợi ý cùng lúc.

## 6. Giới hạn tham số

- Cửa sổ thời gian: 1..90 ngày; ngoài khoảng thì bị kẹp vào khoảng.
- Số run quét tối đa: 2000. Vượt trần thì `truncated` = `true`.

## 7. Giới hạn đã biết

Hai quy tắc gom khác nhau, đừng nhầm:

1. **Gom vai**: vai rỗng, `subagent` và `unknown` gom vào MỘT hàng duy nhất có `role='unknown'`, `group='unknown'`. Nhóm khác chỉ dành cho vai có tên hợp lệ nhưng không khớp nhóm nào; vai rỗng không bao giờ rơi vào nhóm khác.
2. **Gom lần từ chối quyền**: lần từ chối có `agent_id` là `coordinator` được cộng vào `coordinatorDenials` và KHÔNG tạo hàng. Chỉ lần từ chối có `agent_id` không khớp agent nào của run mới được tính vào hàng unknown.

Ngoài ra, run cũ được lưu trước khi có sự kiện `permission.denied` thì thiếu sự kiện này, nên `permissionDenials` thấp hơn thực tế. Run không có agents được đếm ở `runsWithoutAgents`.

## 8. Bảo mật

- Chỉ đọc cục bộ: không ghi, không sửa run hay vai.
- Không gửi dữ liệu ra ngoài máy.
- Không hiển thị prompt hay đường dẫn; chỉ trả tên vai và các con số.
- Route `GET /api/library/role-stats` cần header `X-Controller-Token`; thiếu hoặc sai token thì bị từ chối.
