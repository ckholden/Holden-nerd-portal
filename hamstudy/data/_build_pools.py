"""
One-off build script: converts the verified russolsen/ham_radio_question_pool
JSON (Apache-2.0, see NOTICE.md) into this app's data contract and copies the
referenced figure images alongside it.

Source: C:\\Users\\Christian\\Desktop\\radio\\_hamstudy_source\\ham_radio_question_pool
Re-run after a pool refresh (see that repo's VERIFICATION_REPORT.md for the
recheck procedure) rather than hand-editing the output JSON.
"""
import json
import re
import shutil
from pathlib import Path

SOURCE = Path(r"C:\Users\Christian\Desktop\radio\_hamstudy_source\ham_radio_question_pool")
DEST = Path(__file__).parent

POOLS = [
    ("technician", "technician-2026-2030", "technician-2026-2030.json"),
    ("general", "general-2023-2027", "general-2023-2027.json"),
    ("extra", "extra-2024-2028", "extra-2024-2028.json"),
]

SUBELEMENT_RE = re.compile(r"^[A-Z](\d[A-Z])")


def subelement_of(qid: str, license_class: str) -> str:
    m = SUBELEMENT_RE.match(qid)
    prefix = {"technician": "T", "general": "G", "extra": "E"}[license_class]
    return f"{prefix}{m.group(1)[0]}" if m else ""


def build():
    figures_dir = DEST / "figures"
    figures_dir.mkdir(exist_ok=True)
    summary = {}

    for license_class, subdir, filename in POOLS:
        src_dir = SOURCE / subdir
        raw = json.loads((src_dir / filename).read_text(encoding="utf-8"))

        out = []
        for q in raw:
            figure = q.get("figure") or ""
            if figure:
                src_fig = src_dir / figure
                if src_fig.exists():
                    shutil.copy2(src_fig, figures_dir / figure)
                else:
                    print(f"WARN missing figure {src_fig}")

            out.append({
                "id": q["id"],
                "licenseClass": license_class,
                "subelement": subelement_of(q["id"], license_class),
                "question": q["question"],
                "answers": q["answers"],
                "correctIndex": q["correct"],
                "refs": q.get("refs", ""),
                "figure": figure,
                "explanation": "",
            })

        out_path = DEST / f"{license_class}.json"
        out_path.write_text(json.dumps(out, indent=2, ensure_ascii=False), encoding="utf-8")
        summary[license_class] = len(out)

    print(json.dumps(summary, indent=2))
    print(f"figures copied: {len(list(figures_dir.iterdir()))}")


if __name__ == "__main__":
    build()
