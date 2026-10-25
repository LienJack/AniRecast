"""Character detection, within-shot linking and constrained identity clustering (design §7.2a)."""

from __future__ import annotations

import json
import os
from typing import Any

import numpy as np


def _iou(a: list[float], b: list[float]) -> float:
    ix0, iy0, ix1, iy1 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, ix1 - ix0) * max(0.0, iy1 - iy0)
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def _contains(outer: list[float], inner: list[float]) -> float:
    """Fraction of `inner` inside `outer`."""
    ix0, iy0, ix1, iy1 = max(outer[0], inner[0]), max(outer[1], inner[1]), min(outer[2], inner[2]), min(outer[3], inner[3])
    inter = max(0.0, ix1 - ix0) * max(0.0, iy1 - iy0)
    area = (inner[2] - inner[0]) * (inner[3] - inner[1])
    return inter / area if area > 0 else 0.0


def detect_characters(spec: dict[str, Any]) -> dict[str, Any]:
    """Heads + bodies per sampled frame, linked into tracklets per shot, with CCIP features and crops."""
    from imgutils.detect import detect_heads, detect_person
    from imgutils.metrics import ccip_batch_differences, ccip_batch_extract_features, ccip_default_threshold
    from PIL import Image

    threshold = float(spec.get("threshold") or ccip_default_threshold())
    min_head = float(spec.get("minHeadFraction", 0.04))
    crop_dir = spec["cropDir"]
    out_shots = []
    for shot in spec["shots"]:
        dets = []  # one per detected head
        for fr in shot["frames"]:
            img = Image.open(fr["path"]).convert("RGB")
            w, h = img.size
            heads = [(list(map(float, b)), s) for b, _, s in detect_heads(img) if s >= 0.35]
            people = [(list(map(float, b)), s) for b, _, s in detect_person(img) if s >= 0.3]
            for hb, hs in heads:
                if (hb[3] - hb[1]) / h < min_head:
                    continue
                body = max(people, key=lambda p: _contains(p[0], hb), default=None)
                if body is None or _contains(body[0], hb) < 0.6:
                    cw, ch = hb[2] - hb[0], hb[3] - hb[1]
                    bb = [max(0, hb[0] - cw), max(0, hb[1] - 0.2 * ch), min(w, hb[2] + cw), min(h, hb[3] + 5 * ch)]
                else:
                    bb = body[0]
                dets.append({"frame": fr["frame"], "keyframeId": fr.get("keyframeId"), "head": hb, "body": bb, "score": hs, "img": img, "size": [w, h]})
        if not dets:
            out_shots.append({"shotId": shot["shotId"], "tracklets": []})
            continue
        head_crops = [d["img"].crop(tuple(map(int, d["head"]))) for d in dets]
        body_crops = [d["img"].crop(tuple(map(int, d["body"]))) for d in dets]
        hf = ccip_batch_extract_features(head_crops)
        bf = ccip_batch_extract_features(body_crops)
        diff = ccip_batch_differences(list(hf)) if len(dets) > 1 else np.zeros((1, 1))
        # Link detections across sampled frames: same frame never links; otherwise nearest by identity,
        # with box overlap as a tie-breaker for fast motion.
        order = sorted(range(len(dets)), key=lambda i: dets[i]["frame"])
        tracks: list[list[int]] = []
        for i in order:
            best, best_score = None, None
            for t, members in enumerate(tracks):
                if any(dets[m]["frame"] == dets[i]["frame"] for m in members):
                    continue
                last = members[-1]
                d = float(diff[i][last])
                score = d - 0.05 * _iou(dets[i]["head"], dets[last]["head"])
                if d < threshold * 1.2 and (best_score is None or score < best_score):
                    best, best_score = t, score
            if best is None:
                tracks.append([i])
            else:
                tracks[best].append(i)
        os.makedirs(os.path.join(crop_dir, shot["shotId"]), exist_ok=True)
        tracklets = []
        for t, members in enumerate(tracks):
            detections = []
            for k, m in enumerate(members):
                d = dets[m]
                hp = os.path.join(crop_dir, shot["shotId"], f"t{t}_{k}_head.jpg")
                bp = os.path.join(crop_dir, shot["shotId"], f"t{t}_{k}_body.jpg")
                head_crops[m].save(hp, quality=88)
                body_crops[m].save(bp, quality=85)
                w, h = d["size"]
                detections.append(
                    {
                        "frame": d["frame"],
                        "keyframeId": d["keyframeId"],
                        "headBbox": [d["head"][0] / w, d["head"][1] / h, d["head"][2] / w, d["head"][3] / h],
                        "bodyBbox": [d["body"][0] / w, d["body"][1] / h, d["body"][2] / w, d["body"][3] / h],
                        "score": d["score"],
                        "headCrop": hp,
                        "bodyCrop": bp,
                    }
                )
            tracklets.append(
                {
                    "detections": detections,
                    "identityVec": np.mean(hf[members], axis=0).astype(float).tolist(),
                    "appearanceVec": np.mean(bf[members], axis=0).astype(float).tolist(),
                }
            )
        out_shots.append({"shotId": shot["shotId"], "tracklets": tracklets})
    return {"threshold": threshold, "shots": out_shots}


def _pairwise(vecs: list[list[float]]) -> np.ndarray:
    from imgutils.metrics import ccip_batch_differences

    if len(vecs) < 2:
        return np.zeros((len(vecs), len(vecs)))
    return np.asarray(ccip_batch_differences([np.asarray(v, dtype=np.float32) for v in vecs]))


def cluster_identities(spec: dict[str, Any]) -> dict[str, Any]:
    """
    Constrained average-linkage clustering of tracklets by head identity.
    Must-link groups start merged; cannot-link (explicit or same shot) blocks merges; merging stops at the threshold.
    """
    from imgutils.metrics import ccip_default_threshold

    tracklets = spec["tracklets"]
    threshold = float(spec.get("threshold") or ccip_default_threshold())
    look_threshold = float(spec.get("lookThreshold", threshold * 0.85))
    n = len(tracklets)
    if n == 0:
        return {"threshold": threshold, "clusters": [], "confidence": {}, "uncertain": []}
    ids = [t["id"] for t in tracklets]
    index = {tid: i for i, tid in enumerate(ids)}
    dist = _pairwise([t["identityVec"] for t in tracklets])

    parent = list(range(n))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for a, b in spec.get("mustLink", []):
        if a in index and b in index:
            parent[find(index[a])] = find(index[b])
    cannot = set()
    for a, b in spec.get("cannotLink", []):
        if a in index and b in index:
            cannot.add((index[a], index[b]))
            cannot.add((index[b], index[a]))
    for i in range(n):
        for j in range(n):
            if i != j and tracklets[i]["shotId"] == tracklets[j]["shotId"]:
                cannot.add((i, j))

    clusters: dict[int, list[int]] = {}
    for i in range(n):
        clusters.setdefault(find(i), []).append(i)
    groups = list(clusters.values())

    def blocked(a: list[int], b: list[int]) -> bool:
        return any((i, j) in cannot for i in a for j in b)

    def avg(a: list[int], b: list[int]) -> float:
        return float(np.mean([dist[i][j] for i in a for j in b]))

    while True:
        best = None
        for x in range(len(groups)):
            for y in range(x + 1, len(groups)):
                if blocked(groups[x], groups[y]):
                    continue
                d = avg(groups[x], groups[y])
                if d < threshold and (best is None or d < best[0]):
                    best = (d, x, y)
        if best is None:
            break
        _, x, y = best
        groups[x] = groups[x] + groups[y]
        del groups[y]

    confidence: dict[str, float] = {}
    for g in groups:
        for i in g:
            own = [dist[i][j] for j in g if j != i]
            own_d = float(np.mean(own)) if own else 0.0
            others = [avg([i], h) for h in groups if h is not g]
            nearest = min(others) if others else threshold * 2
            confidence[ids[i]] = float(np.clip((nearest - own_d) / max(threshold, 1e-6), 0.0, 1.0))

    uncertain = []
    for x in range(len(groups)):
        for y in range(x + 1, len(groups)):
            if blocked(groups[x], groups[y]):
                continue
            d = avg(groups[x], groups[y])
            if threshold <= d < threshold * 1.5:
                uncertain.append({"type": "maybe_same", "a": x, "b": y, "distance": d})
        g = groups[x]
        if len(g) > 1:
            spread = max(dist[i][j] for i in g for j in g)
            if spread > threshold * 1.4:
                uncertain.append({"type": "maybe_mixed", "cluster": x, "maxDistance": float(spread)})
        else:
            uncertain.append({"type": "singleton", "cluster": x})

    out = []
    for g in groups:
        looks: list[list[int]] = []
        if len(g) > 1:
            bd = _pairwise([tracklets[i]["appearanceVec"] for i in g])
            assigned = [-1] * len(g)
            for k in range(len(g)):
                if assigned[k] >= 0:
                    continue
                assigned[k] = len(looks)
                looks.append([k])
                for m in range(k + 1, len(g)):
                    if assigned[m] < 0 and float(bd[k][m]) < look_threshold:
                        assigned[m] = assigned[k]
                        looks[assigned[k]].append(m)
        else:
            looks = [[0]]
        out.append({"members": [ids[i] for i in g], "looks": [[ids[g[k]] for k in look] for look in looks]})
    return {"threshold": threshold, "clusters": out, "confidence": confidence, "uncertain": uncertain}


def run_from_file(command: str, path: str) -> dict[str, Any]:
    with open(path, encoding="utf-8") as f:
        spec = json.load(f)
    return detect_characters(spec) if command == "detect-characters" else cluster_identities(spec)
