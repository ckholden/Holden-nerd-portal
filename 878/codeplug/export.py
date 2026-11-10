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

from claude_md_gen import generate_claude_md
from guide_gen import generate_guide

MASTER = Path(r"C:\Users\Christian\OneDrive\radio\878\Christian KJ7DTS")
HERE = Path(__file__).resolve().parent
DOWNLOADS_DIR = HERE / "downloads"

SSH_KEY = Path.home() / ".ssh" / "dsr_voip_ed25519"  # key changed 2026-08-03 (server migration)
SERVER = "kj7dts@192.168.0.151"
SERVER_DIR = "/home/kj7dts/878api"

# canonical boot-image source (Pete's 878 build doesn't have his in the zipped dated
# subfolder -- it's a level up -- so always pull from here rather than trust what's
# already in the person's folder). Keyed by (key, radio), not just key -- the 878/GD-168
# HT boot image is NOT the right size for a mobile radio's screen (e.g. the Maverick
# D890UV), so a radio with no entry here simply gets no boot image force-added.
BOOT_IMAGES_DIR = Path(r"C:\Users\Christian\OneDrive\radio\_boot_images")
BOOT_IMAGE_BY_KEY_RADIO = {
    ("kk7ion", "gd168"): "KK7ION_boot.bmp",
    ("kk7rbq", "878"): "KK7RBQ_boot.bmp",
}

# key -> boot image basename (no extension) -- used to deploy standalone .bmp + _preview.png
# files to the server so 878api.py can serve a "download your boot image anytime" link,
# independent of which radio's zip someone last downloaded. Must match 878api.py's own
# BOOT_IMAGE_FILES map.
BOOT_IMAGE_BASENAME_BY_KEY = {
    "kk7ion": "KK7ION",
    "kk7rbq": "KK7RBQ",
}

# CLAUDE.md is now generated at build time by claude_md_gen.py (2026-08-09) --
# per (key, radio) procedure content (CPS steps, hardware gotchas) combined with a
# policy section derived live from each person's own CSVs (identity, naming
# conventions, current channel/zone/TG counts) so it can't hand-drift out of sync
# with what's actually in the download. See claude_md_gen.py for the content itself.

# key -> radio model -> (folder-layout kind, path, dated-subfolder glob pattern or None).
# "dated"  = person's folder contains a dated "<pattern>" subfolder; export.py picks the newest one.
# "direct" = CSVs sit directly in the given folder (how the GD-168 template folders are laid out).
USER_SOURCES = {
    "kk7ion": {
        # No 878 download since 2026-11-10: Christian says Dad has only the GD-168 + Maverick. The
        # OneDrive "878\Chris KK7ION" master is kept. Must match 878api.py AVAILABLE_RADIOS["kk7ion"].
        "gd168": ("direct", Path(r"C:\Users\Christian\OneDrive\radio\Raddiodity\GD 168\Dad Current Template"), None),
        # NOT tested against real CPS/hardware yet -- see README - conversion notes.txt inside the
        # source folder (also gets bundled into the zip) and the 2026-07-17 CLAUDE.md handoff.
        "maverick": ("dated", Path(r"C:\Users\Christian\OneDrive\radio\BridgeCom Maverick D890UV\Chris KK7ION"), "Maverick CSV *"),
    },
    "kk7rbq": {
        "878": ("dated", Path(r"C:\Users\Christian\OneDrive\radio\878\Pete KK7RBQ"), "878 CSV *"),
    },
    # Christian's own two radios -- he has the masters directly, but wanted the same
    # one-click download buttons everyone else gets rather than digging through OneDrive.
    "admin": {
        "878": ("direct", MASTER, None),
        "gd168": ("direct", Path(r"C:\Users\Christian\OneDrive\radio\Raddiodity\GD 168\Christian Current Template"), None),
        # One-off travel template (2026-10 Charlotte/Roanoke/Abingdon trip), built by
        # Desktop\radio\_build_gd168_travel_202610.py. Must also be in 878api.py's AVAILABLE_RADIOS["admin"].
        "gd168-travel": ("direct", Path(r"C:\Users\Christian\OneDrive\radio\Raddiodity\GD 168\travel-2026-10\KJ7DTS GD-168 TRAVEL 2026-10"), None),
    },
}

# case-insensitive substring match against filename; matches exclude it from the download zip.
# .rdt/.lst are stale CPS working-session artifacts (2026-08-09: found shipping July-dated .rdt
# files that would silently revert a fresh import to pre-rename state if opened directly instead
# of following the CSV-import procedure -- there is no way to regenerate a valid .rdt from CSVs
# without the actual CPS application, so exclude rather than ship something stale). .py build
# scripts aren't useful to an end user either.
EXCLUDE_FROM_ZIP_SUBSTR = ("digitalcontactlist_us_ca", ".bak", ".rdt", ".lst", ".py")

# FIRMWARE.txt (2026-11-10, Christian approved): every zip gets a plain-text firmware note for its radio.
# TEXT ONLY: BridgeCom's download pages grant no redistribution right, so firmware/CPS files are never
# bundled; the note points at the official page. Versions live ONLY in FIRMWARE_LATEST -- when a new
# release ships, change that dict (and FIRMWARE_CHECKED) and re-run export.py.
FIRMWARE_NOTE_NAME = "FIRMWARE.txt"
FIRMWARE_CHECKED = "2026-11-10"
FIRMWARE_LATEST = {  # model -> (latest official FW+CPS, release-file date, official download page)
    "878-v1": ("4.00", "2025-08-15", "https://support.bridgecomsystems.com/anytone-878-v1-model-cps-firmware-downloads"),
    "878-v2": ("4.00", "2025-08-15", "https://support.bridgecomsystems.com/anytone-878-v2-model-cps-firmware-downloads"),
    "d168uv": ("1.07", "2025-06-14", "https://support.bridgecomsystems.com/anytone-168-cps-firmware-downloads"),
    "maverick": ("1.05", "2026-05-21", "https://support.bridgecomsystems.com/maverick-cps-firmware-downloads"),
}
# Which note each download gets.
FIRMWARE_NOTE_BY_KEY_RADIO = {("admin", "878"): "878-v1", ("kk7rbq", "878"): "878-v2"}
FIRMWARE_NOTE_BY_RADIO = {"gd168": "gd168", "gd168-travel": "gd168", "maverick": "maverick"}
FIRMWARE_OWNER = {"admin": "Christian's", "kk7ion": "Chris's", "kk7rbq": "Pete's"}
FIRMWARE_FAMILY_NAME = {"kk7ion": "Chris", "kk7rbq": "Pete"}


def build_firmware_note(key, radio):
    """FIRMWARE.txt text for this download (ASCII, CRLF), or None if no note is defined for the radio."""
    note = FIRMWARE_NOTE_BY_KEY_RADIO.get((key, radio)) or FIRMWARE_NOTE_BY_RADIO.get(radio)
    if note is None:
        return None
    owner = FIRMWARE_OWNER.get(key, "")
    v1, v1_date, v1_url = FIRMWARE_LATEST["878-v1"]
    v2, v2_date, v2_url = FIRMWARE_LATEST["878-v2"]
    L = []
    w = L.append

    def head(title, whose):
        w(f"FIRMWARE - {title}")
        w(f"{(owner + ' ' + whose + '. ') if owner else ''}Checked against the official download pages on {FIRMWARE_CHECKED}.")
        w("")
        if key in FIRMWARE_FAMILY_NAME:
            w(f"{FIRMWARE_FAMILY_NAME[key]}: do not update firmware by yourself. Call Christian (KJ7DTS) first.")
            w("A firmware mistake can damage the radio.")
            w("")

    def rules_878(this_model):
        w("Read all of these before flashing anything:")
        w("1. V1 and V2 878 firmware are NOT interchangeable. The original 878 (D878UV / D878UV PLUS) is V1;")
        w("   the newer one (D878UVII / D878UVII PLUS) is V2. Use only the files for your model. The wrong")
        w("   file can damage the radio." + (f" {this_model}" if this_model else " If you are not sure which model you have, stop."))
        w("2. The CPS version must match the firmware version exactly. After updating to 4.00, program the")
        w("   radio only with the 4.00 CPS for the same model (V1 or V2).")
        w("3. Back up the codeplug first: in the CPS, read the radio and save the file. The update erases the")
        w("   radio's programming. After flashing, do the reset in BridgeCom's update instructions, then")
        w("   write the codeplug back.")
        w("4. V3.07 was withdrawn by BridgeCom (\"removed due to reported issues\"). Never install 3.07.")
        w("   From any older version, go straight to 4.00.")
        w("5. Updating is optional. If the radio works, you do not have to update.")
        w("6. Firmware files are not included in this download. Use only the official files from the page above.")

    if note == "878-v1":
        head("AnyTone AT-D878UV PLUS (original \"V1\" model)", "878")
        w(f"Latest official firmware + CPS: {v1} (release file dated {v1_date})")
        w("Official download page, V1 ONLY:")
        w(f"  {v1_url}")
        w("Installed version: the radio's Device Info screen (in the menu).")
        w("")
        rules_878("This radio is a V1: never flash V2 (D878UVII) files on it.")
    elif note == "878-v2":
        head("AnyTone AT-D878UVII PLUS (\"V2\" model)", "878")
        w(f"Latest official firmware + CPS: {v2} (release file dated {v2_date})")
        w("Official download page, V2 ONLY:")
        w(f"  {v2_url}")
        w("Installed version: the radio's Device Info screen (in the menu).")
        w("")
        rules_878("This radio is a V2: never flash V1 (D878UV) files on it.")
    elif note == "gd168":
        d_ver, d_date, d_url = FIRMWARE_LATEST["d168uv"]
        head("Radioddity GD-168", "GD-168")
        w("We found no public Radioddity download page for GD-168 firmware.")
        w("The GD-168 is closely related to the AnyTone AT-D168UV. BridgeCom's latest official AT-D168UV")
        w(f"firmware + CPS is {d_ver} (release file dated {d_date}):")
        w(f"  {d_url}")
        w("Those AnyTone files have NOT been verified on a GD-168. Do not flash them onto a GD-168 unless")
        w("Radioddity confirms they are the right files for it.")
        w("Installed version: the radio's Device Info screen (Settings > Device Info).")
        w("")
        w("Read all of these before flashing anything:")
        w("1. The CPS version must match the firmware version exactly. If the CPS reports a version")
        w("   mismatch, stop.")
        w("2. Back up the codeplug first: in the CPS, read the radio and save the file. A firmware update")
        w("   erases the radio's programming.")
        w("3. Updating is optional. If the radio works, leave the firmware alone.")
        w("4. Firmware files are not included in this download.")
    elif note == "maverick":
        m_ver, m_date, m_url = FIRMWARE_LATEST["maverick"]
        head("BridgeCom Maverick D890UV", "Maverick")
        w(f"Latest official firmware + CPS: {m_ver} (release file dated {m_date})")
        w("Official download page:")
        w(f"  {m_url}")
        w("Installed version: the radio's Device Info screen (in the menu).")
        w("")
        w("Read all of these before flashing anything:")
        w("1. The CPS version must match the firmware version exactly. Program the radio only with the CPS")
        w("   that matches its firmware.")
        w("2. Back up the codeplug first: in the CPS, read the radio and save the file. The update erases the")
        w("   radio's programming. After flashing, do the factory reset in BridgeCom's update instructions,")
        w("   then write the codeplug back.")
        w("3. The Maverick CPS runs on Windows only.")
        w("4. Use only official BridgeCom files. Unofficial firmware is not covered by the warranty.")
        w("5. Updating is optional. If the radio works, you do not have to update.")
        w("6. Firmware files are not included in this download.")
    else:
        return None
    text = "\n".join(L) + "\n"
    if not text.isascii():
        raise ValueError(f"{key}/{radio}: FIRMWARE note must be plain ASCII")
    return text.replace("\n", "\r\n")


def read_anytone_csv(path):
    with open(path, encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def build_zone_membership(zones):
    """channel name -> [{"n": zone name, "p": 1-based position in that zone's member list,
    "zn": the zone's own CPS "No." (its order in Zone.CSV / on the physical radio)}, ...]"""
    membership = {}
    for z in zones:
        zname = z["Zone Name"]
        zno = int(z["No."])
        members = [m.strip() for m in z["Zone Channel Member"].split("|") if m.strip()]
        for pos, ch in enumerate(members, start=1):
            membership.setdefault(ch, []).append({"n": zname, "p": pos, "zn": zno})
    return membership


def _tone(value, custom):
    """AnyTone CTCSS/DCS cell -> '110.9' / 'D023N' / None. 'Custom' means the channel's Custom CTCSS value."""
    v = (value or "").strip()
    if not v or v.lower() == "off":
        return None
    if v.lower().startswith("custom"):
        return (custom or "").strip() or None
    return v


def build_channel_index(channels, zone_membership):
    out = []
    for row in channels:
        digital = row["Channel Type"].strip().upper().startswith("D")
        tg_raw = row.get("Contact TG/DMR ID", "").strip()
        rec = {
            "n": row["Channel Name"],
            "rx": row["Receive Frequency"],
            "tx": row["Transmit Frequency"],
            "ty": "D" if digital else "A",
            "ct": row["Contact"] if digital and row["Contact"] else None,
            "tg": int(tg_raw) if digital and tg_raw.isdigit() else None,
            "z": zone_membership.get(row["Channel Name"], []),
        }
        # Tones (2026-10-10, Christian: "the tones are in our template"): te = transmit (encode), td = receive
        # (decode) CTCSS/DCS. Analog only, and only when set -- keeps data.json small and lets readers treat a
        # missing key as "no tone". Read by the search page and by Radio's codeplug_lookup on kj7dts-server.
        if not digital:
            te = _tone(row.get("CTCSS/DCS Encode"), row.get("Custom CTCSS"))
            td = _tone(row.get("CTCSS/DCS Decode"), row.get("Custom CTCSS"))
            if te: rec["te"] = te
            if td: rec["td"] = td
        out.append(rec)
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


def find_latest_csv_folder(person_dir, pattern="878 CSV *"):
    candidates = [p for p in person_dir.glob(pattern) if p.is_dir()]
    if not candidates:
        return None

    def mtime(p):
        ch = p / "Channel.CSV"
        return (ch if ch.exists() else p).stat().st_mtime

    return max(candidates, key=mtime)


def should_exclude(name):
    lname = name.lower()
    return any(s in lname for s in EXCLUDE_FROM_ZIP_SUBSTR)


def zip_person_codeplug(key, radio, kind, path, pattern):
    if kind == "dated":
        src = find_latest_csv_folder(path, pattern)
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
    written_names = set()
    with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in src.iterdir():
            if f.is_file() and not should_exclude(f.name):
                zf.write(f, arcname=f.name)
                written_names.add(f.name)
                count += 1
        boot_name = BOOT_IMAGE_BY_KEY_RADIO.get((key, radio))
        boot_added = False
        if boot_name and boot_name not in written_names:
            boot_path = BOOT_IMAGES_DIR / boot_name
            if boot_path.exists():
                zf.write(boot_path, arcname=boot_name)
                count += 1
                boot_added = True

        claude_md_added = False
        claude_md_missing_content = False
        if "CLAUDE.md" not in written_names:
            content = generate_claude_md(key, radio, src)
            if content:
                zf.writestr("CLAUDE.md", content)
                count += 1
                claude_md_added = True
            else:
                claude_md_missing_content = True

        # Printable guide, rebuilt from THIS folder's Zone.CSV on every export (guide_gen.py), so its
        # zone/knob numbers always match the plug. A copy also lands beside the person's CSV folders.
        guide = generate_guide(key, radio, src)
        guide_note = ""
        if guide:
            gname, gtext = guide
            gtext = gtext.replace("\n", "\r\n")
            zf.writestr(gname, gtext)
            count += 1
            guide_note = f" (+ {gname})"
            if kind == "dated":
                gpath = Path(path) / gname
                if not gpath.exists() or gpath.read_text(encoding="utf-8") != gtext.replace("\r\n", "\n"):
                    gpath.write_bytes(gtext.encode("utf-8"))

        # FIRMWARE.txt (2026-11-10): a text pointer to this radio's official firmware page. Never binaries.
        fw_note = ""
        if FIRMWARE_NOTE_NAME not in written_names:
            fw_text = build_firmware_note(key, radio)
            if fw_text:
                zf.writestr(FIRMWARE_NOTE_NAME, fw_text)
                count += 1
                fw_note = f" (+ {FIRMWARE_NOTE_NAME})"
            else:
                fw_note = " (WARNING: no firmware note defined for this radio)"

    note =" (+ boot image)" if boot_added else (" (boot image already included)" if boot_name and boot_name in written_names else (" (no boot image configured for this radio)" if not boot_name else " (WARNING: boot image source file missing)"))
    claude_note = " (+ CLAUDE.md, generated)" if claude_md_added else (" (WARNING: no CLAUDE.md procedure content authored for this key/radio yet)" if claude_md_missing_content else "")
    print(f"{key}-{radio}.zip: {count} files from '{src.name}'{note}{claude_note}{guide_note}{fw_note} -> {out_zip}")


def deploy_to_server():
    if not SSH_KEY.exists():
        print(f"SKIPPED deploy: SSH key not found at {SSH_KEY}")
        return
    subprocess.run(["ssh", "-i", str(SSH_KEY), SERVER, f"mkdir -p {SERVER_DIR}/downloads {SERVER_DIR}/boot_images"], check=True)
    subprocess.run(["scp", "-i", str(SSH_KEY), str(HERE / "data.json"), f"{SERVER}:{SERVER_DIR}/data.json"], check=True)
    for zf in DOWNLOADS_DIR.glob("*.zip"):
        subprocess.run(["scp", "-i", str(SSH_KEY), str(zf), f"{SERVER}:{SERVER_DIR}/downloads/{zf.name}"], check=True)

    boot_count = 0
    for basename in BOOT_IMAGE_BASENAME_BY_KEY.values():
        for suffix in ("_boot.bmp", "_preview.png"):
            f = BOOT_IMAGES_DIR / f"{basename}{suffix}"
            if f.exists():
                subprocess.run(["scp", "-i", str(SSH_KEY), str(f), f"{SERVER}:{SERVER_DIR}/boot_images/{f.name}"], check=True)
                boot_count += 1
            else:
                print(f"WARNING: boot image file missing, not deployed: {f}")

    print(f"Deployed data.json + {len(list(DOWNLOADS_DIR.glob('*.zip')))} zip(s) + {boot_count} boot-image file(s) to {SERVER}:{SERVER_DIR}")


# Retired naming tokens from the 2026-08-07/08-09 reconciliation passes -- if any of
# these literally reappear in the master being exported, that's the exact failure shape
# tonight's incidents kept taking (a stale CPS read reverting a rename). Warn, don't
# block -- a heuristic here would have waved through tonight's own revert (it GREW the
# channel count, it didn't shrink it), so a human running export.py makes the call.
RETIRED_TOKENS = (
    "AUD TEST/BM ECHO", "CASCADES EAST", '"LOCAL 2"', "MTN 2", "NORTH AMERICA",
    "PNW REGIONAL", '"RACOM"', "WASH 1", "WASH 2", "WORLDWIDE ENGLSH", '"TG 99"',
    '"I5"', '"MPRG"', '"HAWAII"', '"INLAND"', '"SAR WV"', '"OR CENTRAL"',
)


def check_regression():
    """Warn (never block) if the build about to be deployed looks materially
    different from what's currently live -- either direction, per the lesson from
    tonight's GD-168 incident (the bad revert GREW the channel count)."""
    new_data = json.loads((HERE / "data.json").read_text(encoding="utf-8"))
    new_counts = new_data["counts"]

    try:
        result = subprocess.run(
            ["ssh", "-i", str(SSH_KEY), SERVER, f"cat {SERVER_DIR}/data.json"],
            capture_output=True, text=True, check=True, timeout=15,
        )
        old_counts = json.loads(result.stdout)["counts"]
        for key in ("channels", "zones"):
            delta = new_counts[key] - old_counts.get(key, new_counts[key])
            if delta != 0:
                print(f"REGRESSION CHECK: {key} changed by {delta:+d} vs currently-live ({old_counts.get(key)} -> {new_counts[key]}) -- confirm this is expected before trusting the deploy")
    except Exception as e:
        print(f"REGRESSION CHECK: could not fetch currently-live counts to compare ({e}) -- skipping count comparison")

    channel_text = (MASTER / "Channel.CSV").read_text(encoding="utf-8-sig")
    talkgroups_text = (MASTER / "TalkGroups.CSV").read_text(encoding="utf-8-sig")
    hits = [t for t in RETIRED_TOKENS if t in channel_text or t in talkgroups_text]
    if hits:
        print(f"REGRESSION CHECK: *** retired naming token(s) found in the master being exported: {hits} *** -- this is the exact shape of a stale-revert incident, verify before trusting this deploy")


def main():
    export_data_json()
    check_regression()
    for key, radios in USER_SOURCES.items():
        for radio, (kind, path, pattern) in radios.items():
            zip_person_codeplug(key, radio, kind, path, pattern)
    deploy_to_server()


if __name__ == "__main__":
    main()
