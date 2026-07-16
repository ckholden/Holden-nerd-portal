#!/usr/bin/env python3
"""Export the 878 master codeplug into data.json + per-person download zips,
then deploy them to the authenticated API on kj7dts-server (878api.py).

Run this as the closing step of any codeplug-editing session that touched
Channel.CSV, Zone.CSV, TalkGroups.CSV, or ScanList.CSV on the 878 master
(OneDrive\\radio\\878\\Christian KJ7DTS\\).

IMPORTANT: data.json and downloads/ are written here for staging only -- they
are .gitignore'd and must NEVER be committed to the (public) portal repo.
The real, access-controlled copy lives only on the server, served by
878api.py behind a verified Firebase ID token. Only the app shell
(index.html, portal-auth-878.js) is public/static.
"""
import csv
import json
import subprocess
import zipfile
from datetime import datetime
from pathlib import Path

MASTER = Path(r"C:\Users\Christian\OneDrive\radio\878\Christian KJ7DTS")
HERE = Path(__file__).resolve().parent
DOWNLOADS_DIR = HERE / "downloads"

SSH_KEY = Path.home() / ".ssh" / "lenovo_ed25519"
SERVER = "kj7dts@192.168.0.151"
SERVER_DIR = "/home/kj7dts/878api"

# key -> radio model -> (folder-layout kind, path).
# "dated"  = person's folder contains a dated "878 CSV *" subfolder; export.py picks the newest one.
# "direct" = CSVs sit directly in the given folder (how the GD-168 template folders are laid out).
USER_SOURCES = {
    "kk7ion": {
        "878": ("dated", Path(r"C:\Users\Christian\OneDrive\radio\878\Chris KK7ION")),
        "gd168": ("direct", Path(r"C:\Users\Christian\OneDrive\radio\Raddiodity\GD 168\Dad Current Template")),
    },
    "kk7rbq": {
        "878": ("dated", Path(r"C:\Users\Christian\OneDrive\radio\878\Pete KK7RBQ")),
    },
}

# case-insensitive substring match against filename; matches exclude it from the download zip
EXCLUDE_FROM_ZIP_SUBSTR = ("digitalcontactlist_us_ca", ".bak")


def read_anytone_csv(path):
    with open(path, encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def build_zone_membership(zones):
    """channel name -> [{"n": zone name, "p": 1-based position in that zone's member list}, ...]"""
    membership = {}
    for z in zones:
        zname = z["Zone Name"]
        members = [m.strip() for m in z["Zone Channel Member"].split("|") if m.strip()]
        for pos, ch in enumerate(members, start=1):
            membership.setdefault(ch, []).append({"n": zname, "p": pos})
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


def zip_person_codeplug(key, radio, kind, path):
    if kind == "dated":
        src = find_latest_csv_folder(path)
        if not src:
            print(f"WARNING: no '878 CSV *' folder found for {key}/{radio} in {path}")
            return
    else:
        src = path
        if not src.is_dir():
            print(f"WARNING: folder not found for {key}/{radio}: {path}")
            return
    DOWNLOADS_DIR.mkdir(parents=True, exist_ok=True)
    out_zip = DOWNLOADS_DIR / f"{key}-{radio}.zip"
    count = 0
    with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in src.iterdir():
            if f.is_file() and not should_exclude(f.name):
                zf.write(f, arcname=f.name)
                count += 1
    print(f"{key}-{radio}.zip: {count} files from '{src.name}' -> {out_zip}")


def deploy_to_server():
    if not SSH_KEY.exists():
        print(f"SKIPPED deploy: SSH key not found at {SSH_KEY}")
        return
    subprocess.run(["ssh", "-i", str(SSH_KEY), SERVER, f"mkdir -p {SERVER_DIR}/downloads"], check=True)
    subprocess.run(["scp", "-i", str(SSH_KEY), str(HERE / "data.json"), f"{SERVER}:{SERVER_DIR}/data.json"], check=True)
    for zf in DOWNLOADS_DIR.glob("*.zip"):
        subprocess.run(["scp", "-i", str(SSH_KEY), str(zf), f"{SERVER}:{SERVER_DIR}/downloads/{zf.name}"], check=True)
    print(f"Deployed data.json + {len(list(DOWNLOADS_DIR.glob('*.zip')))} zip(s) to {SERVER}:{SERVER_DIR}")


def main():
    export_data_json()
    for key, radios in USER_SOURCES.items():
        for radio, (kind, path) in radios.items():
            zip_person_codeplug(key, radio, kind, path)
    deploy_to_server()


if __name__ == "__main__":
    main()
