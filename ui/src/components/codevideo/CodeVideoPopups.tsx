import { pick } from "../../lib/lang";
import { Modal } from "../common/Modal";
import { CodeVideoCreate } from "./CodeVideoCreate";
import { CodeVideoRoom } from "./CodeVideoRoom";
import { CodeVideoSettings } from "./CodeVideoSettings";

/** Popup "new video" (ground floor / add floor of tower 5). */
export function CodeVideoCreatePopup(props: { onCreated: (slug: string) => void; onClose: () => void; onOpenSettings?: () => void }) {
  return (
    <Modal title={pick("Xưởng Dựng Video - Tạo video mới", "Video Studio - New video")} size="large" onClose={props.onClose}>
      {props.onOpenSettings ? (
        <p style={{ textAlign: "right", margin: 0 }}>
          <button type="button" className="cv-secondary" onClick={props.onOpenSettings}>{pick("Cài đặt xưởng (bộ nhận diện)", "Studio settings (brand kit)")}</button>
        </p>
      ) : null}
      <CodeVideoCreate onCreated={props.onCreated} onClose={props.onClose} />
    </Modal>
  );
}

/** Project room popup, titled with the project name. */
export function CodeVideoRoomPopup(props: { slug: string; title?: string | undefined; onDeleted: () => void; onClose: () => void; onChanged?: () => void }) {
  return (
    <Modal title={props.title || pick("Xưởng Dựng Video", "Video Studio")} size="large" onClose={props.onClose}>
      <CodeVideoRoom slug={props.slug} onDeleted={props.onDeleted} {...(props.onChanged ? { onChanged: props.onChanged } : {})} />
    </Modal>
  );
}

/** Settings popup: brand kit, self-review rounds, tool paths. */
export function CodeVideoSettingsPopup(props: { onClose: () => void }) {
  return (
    <Modal title={pick("Xưởng Dựng Video - Cài đặt", "Video Studio - Settings")} size="large" onClose={props.onClose}>
      <CodeVideoSettings />
    </Modal>
  );
}
