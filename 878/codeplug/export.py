#!/usr/bin/env python3
"""Export the 878 master codeplug into holdenportal.com/878's search data + per-person download zips.

Run this as the closing step of any codeplug-editing session that touched
Channel.CSV, Zone.CSV, TalkGroups.CSV, or ScanList.CSV on the 878 master
(OneDrive\\radio\\878\\Christian KJ7DTS\\), then git add/commit/push the
regenerated data.json + zips from this folder (confirm `git branch
--show-current` is `main` first -- this repo is a shared checkout).
"""
import csv
import json
import zipfile
from datetime import datetime
from pathlib import Path

MASTER = Path(r"C:\Users\Christian\OneDrive\radio\878\Christian KJ7DTS")
HERE = Path(__file__).resolve().parent
DOWNLOADS_DIR = HERE / "downloads"

# key -> that person's folder (export.py picks the newest "878 CSV *" subfolder itself)
USER_SOURCES = {
    "kk7ion": Path(r"C:\Users\Christian\OneDrive\radio\878\Chris KK7ION"),
    "kk7rbq": Path(r"C:\Users\Christian\OneDrive\radio\878\Pete KK7RBQ"),
}

# case-insensitive substring match against filename; matches exclude it from the download zip
EXCLUDE_FROM_ZIP_SUBSTR = ("digitalcontactlist_us_ca", ".bak")


def read_anytone_csv(path):
    with open(path, encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def build_zone_membership(zones):
    membership = {}
    for z in zones:
        zname = z["Zone Name"]
        for ch in z["Zone Channel Member"].split("|"):
            ch = ch.strip()
            if ch:
                membership.setdefault(ch, []).append(zname)
    return membership


def build_channel_index(channels, zone_membership):
    out = []
    for row in channels:
        digital = row["Channel Type"].strip().upper().startswith("D")
        tg_raw = row.get("Contact TG/DMR ID", "").strip()
        out.append({
            "n": row["Channel Name"],
            "rx": row["Receive Frequency"],
            "tx": row["Transmit Frequency"],
            "ty": "D" if digital else "A",
            "ct": row["Contact"] if digital and row["Contact"] else None,
            "tg": int(tg_raw) if digital and tg_raw.isdigit() else None,
            "z": zone_membership.get(row["Channel Name"], []),
        })
    return out


def export_data_json():
    channels = read_anytone_csv(MASTER / "Channel.CSV")
    zones = read_anytone_csv(MASTER / "Zone.CSV")
    index = build_channel_index(channels, build_zone_membership(zones))
    data = {
        "generated": datetime.now().astimezone().isoformat(timespec="seconds"),
        "source": "878-KJ7DTS",
        "counts": {"channels": len(index), "zones": len(zones)},
        "channels": index,
    }
    HERE.mkdir(parents=True, exist_ok=True)
    (HERE / "data.json").write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    print(f"data.json: {len(index)} channels, {len(zones)} zones")


def find_latest_csv_folder(person_dir):
    candidates = [p for p in person_dir.glob("878 CSV *") if p.is_dir()]
    if not candidates:
        return None

    def mtime(p):
        ch = p / "Channel.CSV"
        return (ch if ch.exists() else p).stat().st_mtime

    return max(candidates, key=mtime)


def should_exclude(name):
    lname = name.lower()
    return any(s in lname for s in EXCLUDE_FROM_ZIP_SUBSTR)


def zip_person_codeplug(key, person_dir):
    src = find_latest_csv_folder(person_dir)
    if not src:
        print(f"WARNING: no '878 CSV *' folder found for {key} in {person_dir}")
        return
    DOWNLOADS_DIR.mkdir(parents=True, exist_ok=True)
    out_zip = DOWNLOADS_DIR / f"{key}.zip"
    count = 0
    with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in src.iterdir():
            if f.is_file() and not should_exclude(f.name):
                zf.write(f, arcname=f.name)
                count += 1
    print(f"{key}.zip: {count} files from '{src.name}' -> {out_zip}")


def main():
    export_data_json()
    for key, person_dir in USER_SOURCES.items():
        zip_person_codeplug(key, person_dir)


if __name__ == "__main__":
    main()
