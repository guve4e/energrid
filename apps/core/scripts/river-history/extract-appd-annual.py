#!/usr/bin/env python3
"""Extract one APPD daily station PDF into provenance-rich metric CSVs."""
from __future__ import annotations

import argparse
import csv
import json
import re
import subprocess
import sys
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path

SOURCE_URL = "https://www.appd-bg.org/pages?id=opendata"
ROW = re.compile(r"(?P<day>\d{2})\.(?P<month>\d{2})\.(?P<year>\d{4})\s+(?P<level>-?\d+(?:[.,]\d+)?)\s+(?P<discharge>-?\d+(?:[.,]\d+)?)\s+(?P<temperature>-?\d+(?:[.,]\d+)?)")
FIELDS = ["station", "stationCode", "observedDate", "metric", "value", "unit", "provider", "resolution", "aggregation", "quality", "sourceFile", "sourceUrl", "documentYear", "riverKm", "zeroElevationM", "datum"]

@dataclass(frozen=True)
class Reading:
    observed_date: date
    level_cm: float
    discharge_m3s: float | None
    temperature_c: float | None

def parse_rows(text: str) -> tuple[list[Reading], int]:
    rows = []
    for match in ROW.finditer(text):
        d = date(int(match["year"]), int(match["month"]), int(match["day"]))
        vals = [float(match[k].replace(",", ".")) for k in ("level", "discharge", "temperature")]
        rows.append(Reading(d, *vals))
    return rows, len(re.findall(r"\b\d{2}\.\d{2}\.\d{4}\b", text)) - len(rows)

def resolve_pdf(path: Path) -> Path:
    if not path.is_file():
        raise ValueError(f"PDF file does not exist: {path}")
    return path

def validate_rows(rows: list[Reading], year: int) -> dict:
    dates = [r.observed_date for r in rows]
    expected = date(year, 1, 1)
    end = date(year, 12, 31)
    missing = []
    while expected <= end:
        if expected not in dates:
            missing.append(expected.isoformat())
        expected += timedelta(days=1)
    invalid = [r.observed_date.isoformat() for r in rows if not -1000 <= r.level_cm <= 2000 or (r.discharge_m3s is not None and r.discharge_m3s < 0) or (r.temperature_c is not None and not -5 <= r.temperature_c <= 50)]
    return {"duplicates": len(dates) - len(set(dates)), "missingDates": missing, "invalidDates": invalid, "coverageFrom": min(dates).isoformat() if dates else None, "coverageTo": max(dates).isoformat() if dates else None}

def write_csv(path: Path, rows: list[Reading], metric: str, unit: str, meta: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS, lineterminator="\n"); w.writeheader()
        for r in rows:
            value = {"water_level": r.level_cm, "water_discharge": r.discharge_m3s, "water_temperature": r.temperature_c}[metric]
            w.writerow({"station":meta["station"],"stationCode":meta["stationCode"],"observedDate":r.observed_date.isoformat(),"metric":metric,"value":"" if value is None else value,"unit":unit,"provider":"appd-bg","resolution":"daily","aggregation":"daily_mean","quality":"official","sourceFile":meta["sourceFile"],"sourceUrl":meta["sourceUrl"],"documentYear":r.observed_date.year,"riverKm":meta["riverKm"],"zeroElevationM":meta["zeroElevationM"],"datum":meta["datum"]})

def main() -> int:
    p=argparse.ArgumentParser(); p.add_argument("--pdf",required=True,type=Path); p.add_argument("--station",required=True); p.add_argument("--station-code",required=True); p.add_argument("--river-km",required=True,type=float); p.add_argument("--zero-elevation-m",required=True,type=float); p.add_argument("--datum",required=True); p.add_argument("--output-dir",required=True,type=Path); p.add_argument("--report",required=True,type=Path); p.add_argument("--source-url",default=SOURCE_URL); a=p.parse_args()
    pdf=resolve_pdf(a.pdf)
    text=subprocess.run(["pdftotext","-raw",str(pdf),"-"],check=True,capture_output=True,text=True).stdout
    rows,rejected=parse_rows(text)
    if not rows: raise ValueError("No daily observations parsed")
    years={r.observed_date.year for r in rows}
    if len(years)!=1: raise ValueError(f"Expected one document year, got {sorted(years)}")
    year=years.pop(); checks=validate_rows(rows,year)
    if checks["duplicates"] or checks["invalidDates"]: raise ValueError(f"Invalid extracted records: {checks}")
    meta={"station":a.station,"stationCode":a.station_code,"riverKm":a.river_km,"zeroElevationM":a.zero_elevation_m,"datum":a.datum,"sourceFile":a.pdf.name,"sourceUrl":a.source_url}
    outs={}
    for metric,unit in (("water_level","cm"),("water_discharge","m3/s"),("water_temperature","C")):
        out=a.output_dir/f"{a.station_code}-{metric.replace('_','-')}-{year}.csv"; write_csv(out,rows,metric,unit,meta); outs[metric]=str(out)
    report={**meta,"year":year,"rowsExtracted":len(rows),"rejectedDateRows":rejected,"usableLevelDates":len({r.observed_date for r in rows}),**checks,"outputs":outs}
    a.report.parent.mkdir(parents=True,exist_ok=True); a.report.write_text(json.dumps(report,indent=2),encoding="utf-8"); print(json.dumps(report,indent=2)); return 0
if __name__ == "__main__":
    try: raise SystemExit(main())
    except (ValueError, subprocess.CalledProcessError) as e: print(str(e),file=sys.stderr); raise SystemExit(1)
