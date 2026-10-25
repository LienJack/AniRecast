"""AniRecast Python sidecar.

Every command prints exactly one JSON object on the last stdout line; logs go to stderr.
Heavy imports (imgutils, onnxruntime) are deferred so `detect-shots` stays fast.
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any


def _emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _log(message: str) -> None:
    sys.stderr.write(message + "\n")
    sys.stderr.flush()


def detect_shots(args: argparse.Namespace) -> dict[str, Any]:
    """Cut detection on a constant-frame-rate clip; shots are inclusive frame ranges."""
    from scenedetect import SceneManager, open_video
    from scenedetect.detectors import AdaptiveDetector, ContentDetector

    video = open_video(args.video)
    manager = SceneManager()
    if args.detector == "content":
        manager.add_detector(ContentDetector(threshold=args.threshold or 27.0, min_scene_len=args.min_scene_len))
    else:
        manager.add_detector(
            AdaptiveDetector(adaptive_threshold=args.threshold or 3.0, min_scene_len=args.min_scene_len)
        )
    manager.detect_scenes(video, show_progress=False)
    frame_count = int(video.frame_number)
    scenes = manager.get_scene_list(start_in_scene=True)
    shots = []
    for start, end in scenes:
        s, e = start.frame_num, end.frame_num - 1  # scenedetect end is exclusive
        if e >= s:
            shots.append({"start": int(s), "end": int(e)})
    if not shots and frame_count > 0:
        shots = [{"start": 0, "end": frame_count - 1}]
    _log(f"detect-shots: {len(shots)} shots over {frame_count} frames")
    return {
        "detector": args.detector,
        "frameCount": frame_count,
        "fps": float(video.frame_rate),
        "shots": shots,
        "cuts": [s["start"] for s in shots[1:]],
    }


def main() -> None:
    parser = argparse.ArgumentParser(prog="anirecast-py")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("detect-shots", help="detect cuts in a video")
    p.add_argument("--video", required=True)
    p.add_argument("--detector", choices=["adaptive", "content"], default="adaptive")
    p.add_argument("--threshold", type=float, default=None)
    p.add_argument("--min-scene-len", type=int, default=6)
    p.set_defaults(func=detect_shots)

    args = parser.parse_args()
    try:
        _emit({"ok": True, "data": args.func(args)})
    except Exception as error:  # noqa: BLE001 - every failure must still be one JSON line
        _emit({"ok": False, "error": {"code": "internal", "message": f"{type(error).__name__}: {error}"}})
        sys.exit(1)
