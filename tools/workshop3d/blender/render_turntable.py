"""Turntable (quay tròn trên bệ tròn) của một GLB Xưởng 3D, chạy trong Blender (spawn bởi src/core/workshop3d/turntable.ts).

Usage: blender -b --factory-startup -noaudio -P render_turntable.py -- <job.json>
job.json: {glb, out_dir, width, height, frames, fps?, samples, engine ('eevee'|'cycles'),
           background: {color: '#rrggbb'|null}, pedestal: bool, orbit: {elevation_deg, turns},
           materials?: <materials.json của phiên>, libraryDir?, polyhavenDir?}
Ghi out_dir/frame_0001.png ... frame_NNNN.png (RGBA, nền trong suốt; bóng của bệ nằm trong kênh alpha).
Màu nền KHÔNG được trộn ở đây: ghép ffmpeg đặt màu thương hiệu sau (chính xác từng mã màu, không bị AgX đổi màu).
Mô hình đứng yên giữa cảnh, "bàn xoay" (mô hình + bệ) quay quanh trục dọc nên ánh sáng studio luôn cố định so với camera.
In một dòng `W3D_RESULT {json}` (ok, frames, engine, seconds, secondsPerFrame, camera, warnings), thoát 0; lỗi: ok=false, thoát 1.
"""
import json
import math
import os
import sys
import time
import traceback

sys.dont_write_bytecode = True  # không để lại __pycache__ cạnh script
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy  # noqa: E402
from mathutils import Vector  # noqa: E402

import w3d_bscene as S  # noqa: E402

T0 = time.time()
LENS = 50.0
SENSOR = 36.0
MARGIN = 1.12


def result(obj, code):
    print("W3D_RESULT " + json.dumps(obj, ensure_ascii=False), flush=True)
    sys.stdout.flush()
    os._exit(code)


def white_mat(name, rough, spec_tint=0.5):
    m = bpy.data.materials.new(name)
    m.use_nodes = True  # noqa
    b = m.node_tree.nodes.get("Principled BSDF")
    b.inputs["Base Color"].default_value = (0.9, 0.91, 0.93, 1)
    b.inputs["Roughness"].default_value = rough
    for k in ("Specular IOR Level", "Specular"):
        if k in b.inputs:
            b.inputs[k].default_value = spec_tint
            break
    return m


def add_pedestal(box, pivot):
    """Bệ tròn trắng, mặt trên chạm đáy mô hình, bán kính phủ hết vết chân mô hình. Trả về (object, bán kính, độ dày)."""
    mn, mx = box
    r = 0.5 * math.hypot(mx.x - mn.x, mx.y - mn.y) * 1.1
    r = max(r, 0.3)
    t = max(0.03, 0.07 * r)
    bpy.ops.mesh.primitive_cylinder_add(vertices=128, radius=r, depth=t, location=(pivot.x, pivot.y, mn.z - t / 2 - 0.0005))
    ped = bpy.context.active_object
    ped.name = "pedestal"
    bev = ped.modifiers.new("bevel", "BEVEL")
    bev.width = min(t * 0.35, 0.02)
    bev.segments = 4
    bev.limit_method = "ANGLE"
    ped.data.materials.append(white_mat("pedestal_mat", 0.28))
    for p in ped.data.polygons:
        p.use_smooth = True
    return ped, r, t


def add_ground(zbottom, size):
    """Mặt phẳng hứng bóng (chỉ bóng, không thấy hình) ngay dưới bệ."""
    bpy.ops.mesh.primitive_plane_add(size=size, location=(0, 0, zbottom - 0.001))
    g = bpy.context.active_object
    g.name = "ground_catcher"
    try:
        g.is_shadow_catcher = True
    except Exception:  # noqa: BLE001 - bản Blender không hỗ trợ
        g.visible_camera = False
        S.warn("Blender này không có shadow catcher: không có bóng dưới bệ.")
    return g


def area_light(name, loc, tgt, size, energy, color=(1.0, 0.98, 0.95)):
    ld = bpy.data.lights.new(name, "AREA")
    ld.shape = "RECTANGLE"
    ld.size = size
    ld.size_y = size
    ld.energy = energy
    ld.color = color
    lo = bpy.data.objects.new(name, ld)
    lo.location = loc
    lo.rotation_euler = (Vector(tgt) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.collection.objects.link(lo)
    return lo


def setup_world():
    sc = bpy.context.scene
    world = bpy.data.worlds.new("turntable_world")
    sc.world = world
    world.use_nodes = True
    nt = world.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    bg = nt.nodes.new("ShaderNodeBackground")
    bg.inputs["Color"].default_value = (0.92, 0.94, 1.0, 1)
    bg.inputs["Strength"].default_value = 0.55
    out = nt.nodes.new("ShaderNodeOutputWorld")
    nt.links.new(bg.outputs[0], out.inputs[0])


def compute_camera(box, ped_r, ped_t, elevation_deg, aspect):
    """Camera nhìn vào tâm hộp bao (kể cả bệ) từ độ cao elevation_deg; khoảng cách đủ cho mọi góc quay."""
    mn, mx = box
    zlo = mn.z - ped_t
    zhi = mx.z
    c = Vector(((mn.x + mx.x) / 2, (mn.y + mx.y) / 2, (zlo + zhi) / 2))
    # chu vi tròn tại pivot: thay mọi góc quay bằng các điểm bán kính = bán kính ngoài xa nhất (hộp bao + bệ)
    corners_r = max(math.hypot(x - c.x, y - c.y) for x in (mn.x, mx.x) for y in (mn.y, mx.y))
    rad = max(corners_r, ped_r)
    el = math.radians(elevation_deg)
    fwd = Vector((0, -math.cos(el), -math.sin(el)))  # từ camera vào tâm (camera ở -Y, nhìn ra +Y, hơi chúc xuống)
    right = Vector((1, 0, 0))
    up = right.cross(fwd).normalized()
    up = Vector((0, 0, 1)) if abs(up.z) < 1e-6 else up
    right = fwd.cross(Vector((0, 0, 1))).normalized()
    up = right.cross(fwd).normalized()
    hfov = 2 * math.atan(SENSOR / 2 / LENS)
    if aspect >= 1:
        tx = math.tan(hfov / 2)
        ty = tx / aspect
    else:
        ty = math.tan(hfov / 2)
        tx = ty * aspect
    pts = []
    for ang in range(0, 360, 10):
        a = math.radians(ang)
        for zz in (zlo, zhi):
            pts.append(Vector((c.x + rad * math.cos(a), c.y + rad * math.sin(a), zz)))
    need = 0.0
    for p in pts:
        v = p - c
        xr, yr, zr = v.dot(right), v.dot(up), v.dot(fwd)
        need = max(need, abs(xr) / tx - zr, abs(yr) / ty - zr)
    dist = need * MARGIN
    loc = c - fwd * dist
    return {"loc": loc, "tgt": c, "dist": dist, "radius": rad}


def main():
    job = json.load(open(sys.argv[sys.argv.index("--") + 1], encoding="utf-8"))
    out_dir = job["out_dir"]
    os.makedirs(out_dir, exist_ok=True)
    width, height = int(job["width"]), int(job["height"])
    frames = max(1, int(job["frames"]))
    samples = max(1, int(job.get("samples", 16)))
    engine = job.get("engine", "eevee")
    orbit = job.get("orbit") or {}
    elevation = float(orbit.get("elevation_deg", 12))
    turns = float(orbit.get("turns", 1))

    objs = S.load_scene(job["glb"])
    if not objs:
        result({"ok": False, "error": "GLB không có lưới nào."}, 1)
    mats = job.get("materials")
    if mats and os.path.isfile(mats):
        # GLB chưa nướng vật liệu (model.glb): áp vật liệu của phiên như bước render chất lượng cao
        spec = json.load(open(mats, encoding="utf-8")).get("materials", {})
        spec = S.inherit_materials(objs, spec)
        assets = S.polyhaven_assets(job.get("polyhavenDir"))
        S.apply_materials(objs, spec, assets, job.get("libraryDir"), mats, None)
    box = S.scene_box(objs)
    mn, mx = box
    pivot = Vector(((mn.x + mx.x) / 2, (mn.y + mx.y) / 2, mn.z))

    # bàn xoay: empty tại tâm đáy, mô hình + bệ là con của nó
    table = bpy.data.objects.new("turntable", None)
    bpy.context.scene.collection.objects.link(table)
    table.location = pivot
    parts = list(objs)
    ped_r, ped_t = 0.0, 0.0
    if job.get("pedestal", True):
        ped, ped_r, ped_t = add_pedestal(box, pivot)
        parts.append(ped)
    bpy.context.view_layer.update()
    for o in parts:
        mw = o.matrix_world.copy()
        o.parent = table
        o.matrix_parent_inverse = table.matrix_world.inverted()
        o.matrix_world = mw
    zbottom = mn.z - ped_t
    if job.get("pedestal", True):
        g = add_ground(zbottom, max(50.0, (mx - mn).length * 30))
        g.hide_viewport = False

    setup_world()
    cam = compute_camera(box, ped_r, ped_t, elevation, width / height)
    diag = max((mx - mn).length, 2 * ped_r)
    c = cam["tgt"]
    h = mx.z - mn.z
    # ánh sáng studio mềm: đèn chính lớn phía trên-trước-bên, đèn lấp mờ phía đối diện, đèn viền sau để rõ mép
    area_light("key", (c.x - 1.4 * diag, c.y - 1.6 * diag, mx.z + 1.2 * diag), c, 1.6 * diag, 110 * diag * diag)
    area_light("fill", (c.x + 1.8 * diag, c.y - 0.9 * diag, c.z + 0.2 * diag), c, 1.8 * diag, 45 * diag * diag, (0.92, 0.95, 1.0))
    area_light("rim", (c.x + 0.4 * diag, c.y + 1.7 * diag, mx.z + 0.6 * diag), c, 1.2 * diag, 70 * diag * diag)
    area_light("top", (c.x, c.y, mx.z + 2.0 * diag), c, 2.2 * diag, 80 * diag * diag)

    cd = bpy.data.cameras.new("cam")
    cd.sensor_width = SENSOR
    cd.lens = LENS
    cd.clip_start = 0.01
    cd.clip_end = max(100.0, diag * 20)
    co = bpy.data.objects.new("cam", cd)
    bpy.context.scene.collection.objects.link(co)
    co.location = cam["loc"]
    co.rotation_euler = (cam["tgt"] - cam["loc"]).to_track_quat("-Z", "Y").to_euler()
    sc = bpy.context.scene
    sc.camera = co

    # kết xuất
    device_used = "CPU"
    if engine == "cycles":
        device_used = S.setup_render(width, height, samples, "cpu", 0.0, os.path.join(out_dir, "frame_"))
        cy = sc.cycles
        cy.use_adaptive_sampling = True
        cy.max_bounces = 3
        cy.diffuse_bounces = 2
        cy.glossy_bounces = 2
        cy.transparent_max_bounces = 2
        cy.transmission_bounces = 2
        cy.use_denoising = True
        sc.render.use_persistent_data = True  # BVH và cảnh dùng lại giữa các khung (chỉ bàn xoay đổi)
        sc.render.threads_mode = "AUTO"
    else:
        eng_names = [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items]
        sc.render.engine = "BLENDER_EEVEE" if "BLENDER_EEVEE" in eng_names else "BLENDER_EEVEE_NEXT"
        try:
            sc.eevee.taa_render_samples = samples
        except Exception:  # noqa: BLE001
            pass
        for attr, val in (("use_shadows", True), ("use_raytracing", False), ("use_gtao", True)):
            try:
                setattr(sc.eevee, attr, val)
            except Exception:  # noqa: BLE001
                pass
        sc.render.resolution_x, sc.render.resolution_y = width, height
        sc.render.resolution_percentage = 100
        try:
            sc.view_settings.view_transform = "AgX"
            sc.view_settings.look = "AgX - Medium High Contrast"
        except Exception as e:  # noqa: BLE001
            S.warn(f"Không đặt được AgX: {e}")
    sc.view_settings.exposure = float(job.get("exposure", 0.0))
    sc.render.film_transparent = True
    sc.render.image_settings.file_format = "PNG"
    sc.render.image_settings.color_mode = "RGBA"
    sc.render.image_settings.color_depth = "8"
    sc.render.filepath = os.path.join(out_dir, "frame_")
    sc.render.use_file_extension = True
    sc.frame_start = 1
    sc.frame_end = frames
    sc.render.fps = int(job.get("fps", 24))

    # xoay đều tuyến tính, không gồm điểm 360 cuối để vòng lặp không trùng khung
    table.rotation_mode = "XYZ"
    table.rotation_euler = (0, 0, 0)
    table.keyframe_insert("rotation_euler", index=2, frame=1)
    table.rotation_euler = (0, 0, 2 * math.pi * turns * frames / max(1, frames))
    table.keyframe_insert("rotation_euler", index=2, frame=frames + 1)
    ad = table.animation_data
    fcs = []
    if ad and ad.action:
        try:
            fcs = list(ad.action.fcurves)
        except Exception:  # noqa: BLE001 - Blender 5 dùng layered action
            try:
                for layer in ad.action.layers:
                    for strip in layer.strips:
                        for bag in strip.channelbags:
                            fcs.extend(bag.fcurves)
            except Exception:  # noqa: BLE001
                fcs = []
    for fc in fcs:
        for kp in fc.keyframe_points:
            kp.interpolation = "LINEAR"
    if not fcs:
        S.warn("Không đặt được nội suy tuyến tính: bàn xoay có thể tăng/giảm tốc.")

    t = time.time()
    bpy.ops.render.render(animation=True)
    done = sorted(f for f in os.listdir(out_dir) if f.startswith("frame_") and f.endswith(".png"))
    if len(done) < frames:
        result({"ok": False, "error": f"Blender chỉ ghi {len(done)}/{frames} khung."}, 1)
    dt = time.time() - t
    result({
        "ok": True, "frames": len(done), "engine": engine, "device": device_used,
        "seconds": round(time.time() - T0, 1), "renderSeconds": round(dt, 1), "secondsPerFrame": round(dt / max(1, len(done)), 2),
        "camera": {"location": [round(v, 3) for v in cam["loc"]], "target": [round(v, 3) for v in cam["tgt"]], "distance": round(cam["dist"], 3)},
        "pedestal": {"radius": round(ped_r, 3), "thickness": round(ped_t, 3)}, "warnings": S.WARNINGS,
    }, 0)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        traceback.print_exc()
        result({"ok": False, "error": f"{type(e).__name__}: {e}"[:600]}, 1)
