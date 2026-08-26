#!/usr/bin/env python3
"""Turns a video file into a Baseline-Vision clip file.

The measurement chain does not start at pixels: it starts at per-frame 2D
joints with detector scores. This script produces those from an MP4 using an
off-the-shelf pose estimator, so the estimator stays outside the measurement
chain and can be swapped without touching it.

    pip install mediapipe opencv-python          # or: pip install ultralytics opencv-python
    python tools/extract-pose.py aufschlag.mp4 clip.json \
        --height-cm 185 --hand right --level high_performance \
        --capture-fps 240 --hfov 62 --contact-frame 276

Two backends:

  mediapipe   33 landmarks, and — importantly — `pose_world_landmarks`, a
              root-relative 3D estimate in metres. That is written to the clip
              as the depth track, which is what lets the reconstruction resolve
              the depth direction. Without it the report will decline to quote
              any angle, by design.

  ultralytics COCO-17 from YOLO-pose. More robust on small, fast figures, but
              2D only: pair it with a monocular lifter if you want angles.

What the script cannot do for you:

  * Find the contact instant. Nothing in a bare pose track marks the moment ball
    meets strings, and every timing measurement is referenced to it. Step
    through the video, note the frame number, pass it as --contact-frame.
  * Know the focal length. Pass --hfov if you can find it; the analysis says so
    when it has to guess.
  * Know whether the clip is slow motion. --capture-fps is the rate the scene
    was *captured* at, which may be far above the rate the file plays at, and
    it decides whether timing analysis is admissible at all.
"""

import argparse
import json
import sys

try:
    import cv2
except ImportError:  # pragma: no cover - environment dependent
    sys.exit("opencv-python fehlt: pip install opencv-python")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Video -> Baseline-Vision-Clip")
    p.add_argument("video")
    p.add_argument("out")
    p.add_argument("--backend", choices=["mediapipe", "ultralytics"], default="mediapipe")
    p.add_argument("--height-cm", type=float, required=True, help="Körpergröße des Spielers")
    p.add_argument("--hand", choices=["right", "left"], default="right")
    p.add_argument(
        "--level",
        default="high_performance",
        choices=["junior_development", "junior_national", "college", "high_performance", "elite"],
    )
    p.add_argument("--age", type=int, default=None)
    p.add_argument("--stroke", default="serve", choices=["serve", "forehand", "backhand"])
    p.add_argument("--hfov", type=float, default=None, help="horizontaler Bildwinkel in Grad")
    p.add_argument("--capture-fps", type=float, default=None, help="Aufnahmerate, falls Zeitlupe")
    p.add_argument("--contact-frame", type=int, default=None, help="Bildnummer des Treffpunkts")
    p.add_argument("--start", type=int, default=0, help="erstes zu lesendes Bild")
    p.add_argument("--end", type=int, default=None, help="letztes zu lesendes Bild")
    p.add_argument("--no-depth", action="store_true", help="Tiefenspur nicht mitschreiben")
    p.add_argument("--flip-depth", action="store_true", help="Vorzeichen der Tiefenspur umkehren")
    p.add_argument("--model", default="yolo11n-pose.pt", help="nur für --backend ultralytics")
    return p.parse_args()


def extract_mediapipe(frames, args):
    """33 landmarks plus a root-relative 3D track, from MediaPipe Pose."""
    import mediapipe as mp

    pose = mp.solutions.pose.Pose(
        static_image_mode=False,
        model_complexity=2,
        smooth_landmarks=False,  # the pipeline does its own filtering, in metres
        min_detection_confidence=0.4,
        min_tracking_confidence=0.4,
    )
    out = []
    for image in frames:
        result = pose.process(cv2.cvtColor(image, cv2.COLOR_BGR2RGB))
        height, width = image.shape[:2]
        if not result.pose_landmarks:
            out.append({"keypoints": [None] * 33})
            continue
        keypoints = []
        for lm in result.pose_landmarks.landmark:
            # `visibility` is MediaPipe's own confidence; it is passed through
            # unchanged because the pipeline weights by it and reports coverage.
            keypoints.append([lm.x * width, lm.y * height, float(lm.visibility)])
        frame = {"keypoints": keypoints}
        if not args.no_depth and result.pose_world_landmarks:
            # World landmarks are metres relative to the hip centre, and
            # MediaPipe's z grows *away* from the camera — the smaller the
            # value, the closer the landmark. That is the same direction the
            # clip format calls depth, so the value is taken as it stands.
            # If the reconstruction keeps reporting a low "Tiefenrichtung
            # gesichert", pass --flip-depth and compare.
            sign = -1.0 if args.flip_depth else 1.0
            frame["depth"] = [sign * lm.z for lm in result.pose_world_landmarks.landmark]
        out.append(frame)
    pose.close()
    return out, "mediapipe33"


def extract_ultralytics(frames, args):
    """COCO-17 from YOLO-pose. Two-dimensional only."""
    from ultralytics import YOLO

    model = YOLO(args.model)
    out = []
    for image in frames:
        result = model.predict(image, verbose=False)[0]
        if result.keypoints is None or len(result.keypoints.data) == 0:
            out.append({"keypoints": [None] * 17})
            continue
        # The largest detected person: on a tennis court the player fills more
        # of the frame than anyone in the background.
        areas = [float(b[2] - b[0]) * float(b[3] - b[1]) for b in result.boxes.xyxy]
        best = max(range(len(areas)), key=lambda i: areas[i])
        data = result.keypoints.data[best].tolist()
        out.append({"keypoints": [[x, y, float(score)] for x, y, score in data]})
    return out, "coco17"


def main() -> None:
    args = parse_args()
    capture = cv2.VideoCapture(args.video)
    if not capture.isOpened():
        sys.exit(f"Video nicht lesbar: {args.video}")

    fps = capture.get(cv2.CAP_PROP_FPS) or 30.0
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))

    frames = []
    index = 0
    while True:
        ok, image = capture.read()
        if not ok:
            break
        if index >= args.start and (args.end is None or index <= args.end):
            frames.append(image)
        index += 1
        if args.end is not None and index > args.end:
            break
    capture.release()
    if not frames:
        sys.exit("Keine Bilder gelesen — Bereich prüfen (--start/--end).")

    extract = extract_mediapipe if args.backend == "mediapipe" else extract_ultralytics
    detections, layout = extract(frames, args)

    found = sum(1 for d in detections if any(k is not None for k in d["keypoints"]))
    print(f"{found} von {len(detections)} Bildern mit erkannter Person.", file=sys.stderr)

    contact = args.contact_frame
    if contact is not None:
        contact -= args.start
        if contact < 0 or contact >= len(detections):
            sys.exit("--contact-frame liegt außerhalb des ausgeschnittenen Bereichs.")

    clip = {
        "format": "baseline-vision-clip",
        "version": 1,
        "video": {
            "fps": round(fps, 3),
            "captureFps": args.capture_fps or round(fps, 3),
            "widthPx": width,
            "heightPx": height,
            **({"hfovDeg": args.hfov} if args.hfov else {}),
        },
        "player": {
            "id": "clip",
            "displayName": "Spieler",
            "heightCm": args.height_cm,
            "hand": args.hand,
            "backhand": "two_handed",
            "level": args.level,
            **({"ageYears": args.age} if args.age else {}),
        },
        "stroke": args.stroke,
        "keypointLayout": layout,
        **({"contactFrame": contact} if contact is not None else {}),
        "source": f"{args.video} via {args.backend}",
        "frames": [
            {
                "t": round(i / fps, 6),
                "keypoints": [
                    None if k is None else [round(k[0], 2), round(k[1], 2), round(k[2], 3)]
                    for k in d["keypoints"]
                ],
                **({"depth": [round(z, 4) for z in d["depth"]]} if "depth" in d else {}),
            }
            for i, d in enumerate(detections)
        ],
    }

    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(clip, handle)
    print(f"{args.out} geschrieben: {len(clip['frames'])} Bilder, Layout {layout}.", file=sys.stderr)
    if contact is None:
        print(
            "Kein Treffpunkt markiert. Ohne ihn bleiben fast alle Kenngrößen unbestimmt — "
            "Bildnummer heraussuchen und mit --contact-frame erneut ausführen.",
            file=sys.stderr,
        )


if __name__ == "__main__":
    main()
