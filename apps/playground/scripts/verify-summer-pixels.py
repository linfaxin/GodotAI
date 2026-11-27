"""Recompute marker locations from the original Playground PNGs and Summer images."""

import hashlib
from io import BytesIO
import json
from pathlib import Path
import sys

from PIL import Image


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read_report(directory):
    return json.loads((directory / "report.json").read_text(encoding="utf-8"))


def inspect_image(root, directory, sample):
    filename = directory / sample["file"]
    require(filename.name == sample["file"] and filename.resolve().parent == directory, filename)
    data = filename.read_bytes()
    require(len(data) == sample.get("byteLength", sample.get("bytes")), filename)
    require(hashlib.sha256(data).hexdigest() == sample["sha256"], filename)
    with Image.open(BytesIO(data)) as encoded:
        format_name = {"image/png": "PNG", "image/jpeg": "JPEG"}[sample.get("mime", "image/png")]
        require(encoded.format == format_name, filename)
        if "width" in sample:
            require(encoded.size == (sample["width"], sample["height"]), filename)
        image = encoded.convert("RGB")

    count = total_x = total_y = 0
    pixels = image.tobytes()
    for offset in range(0, len(pixels), 3):
        if min(pixels[offset:offset + 3]) >= 235:
            index = offset // 3
            count += 1
            total_x += index % image.width
            total_y += index // image.width
    require(count >= 16, f"No white marker in {filename}")
    actual = [round(total_x / count, 2), round(total_y / count, 2)]
    position = sample["position"]
    expected = [position["x"] * image.width / 960, position["y"] * image.height / 640]
    require(max(abs(a - e) for a, e in zip(actual, expected)) <= 3,
            f"Marker centroid disagrees with the observed position in {filename}: {actual} vs {expected}")
    return {"file": filename.relative_to(root).as_posix(), "position": position, "frame": sample["frame"],
            "sha256": sample["sha256"], "whiteMarkerCentroid": actual,
            "expectedCentroid": expected, "whitePixels": count, "size": list(image.size)}


def verify_playground_report(root, variant):
    directory = root / "reports" / variant
    samples = read_report(directory)["pngs"]
    expected = ["previous-physical.png"] if variant.endswith("old") else ["before.png", "after.png", "restart.png"]
    require([sample["file"] for sample in samples] == expected, directory)
    return [inspect_image(root, directory, sample) for sample in samples]


def verify(root):
    reports = root / "reports"
    observations = {}
    variants = ["new", "old", "replay-new", "replay-old"]
    manual_report = reports / "manual-archive" / "report.json"
    if manual_report.is_file() and read_report(manual_report.parent).get("mode") == "headed-interactive-operator-walkthrough":
        variants.append("manual-archive")
    for variant in variants:
        observations[variant] = verify_playground_report(root, variant)

    directory = reports / "summer-native"
    if (directory / "report.json").is_file():
        samples = read_report(directory)["images"]
        names = [Path(sample["file"]).stem for sample in samples]
        require(names == ["before", "after", "restart"][:len(names)], directory)
        observations["summer-native"] = [inspect_image(root, directory, sample) for sample in samples]
    return {"status": "passed", "observations": observations}


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[2] == "--replay":
        result = verify_playground_report(Path(sys.argv[1]).resolve(), "new")
    elif len(sys.argv) == 2:
        result = verify(Path(sys.argv[1]).resolve())
    else:
        sys.exit("Usage: python3 verify-summer-pixels.py EVIDENCE_ROOT [--replay]")
    print(json.dumps(result, indent=2))
