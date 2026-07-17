#!/usr/bin/env python3

from __future__ import annotations

import argparse
import csv
import json
import re
import subprocess
import sys
from dataclasses import dataclass
from datetime import date
from pathlib import Path


ROW_PATTERN = re.compile(
    r"(?P<day>\d{2})\.(?P<month>\d{2})\.(?P<year>\d{4})"
    r"\s+"
    r"(?P<level>-?\d+(?:[.,]\d+)?)"
    r"\s+"
    r"(?P<discharge>-?\d+(?:[.,]\d+)?)"
    r"\s+"
    r"(?P<temperature>-?\d+(?:[.,]\d+)?)"
)


@dataclass(frozen=True)
class AnnualReading:
    observed_date: date
    water_level: float
    water_discharge: float
    water_temperature: float


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pdf", required=True, type=Path)
    parser.add_argument("--station", required=True)
    parser.add_argument("--station-code", required=True)
    parser.add_argument("--provider", default="appd-bg")
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path)
    return parser.parse_args()


def parse_number(raw: str) -> float:
    return float(raw.replace(",", "."))


def extract_text(pdf_path: Path) -> str:
    result = subprocess.run(
        ["pdftotext", "-raw", str(pdf_path), "-"],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout


def parse_rows(text: str) -> list[AnnualReading]:
    rows: list[AnnualReading] = []

    for match in ROW_PATTERN.finditer(text):
        observed_date = date(
            int(match.group("year")),
            int(match.group("month")),
            int(match.group("day")),
        )

        rows.append(
            AnnualReading(
                observed_date=observed_date,
                water_level=parse_number(match.group("level")),
                water_discharge=parse_number(match.group("discharge")),
                water_temperature=parse_number(match.group("temperature")),
            )
        )

    return rows


def write_metric_csv(
    output_path: Path,
    rows: list[AnnualReading],
    station: str,
    station_code: str,
    provider: str,
    source_file: str,
    metric: str,
    unit: str,
) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with output_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)

        writer.writerow(
            [
                "station",
                "stationCode",
                "observedDate",
                "metric",
                "value",
                "unit",
                "provider",
                "resolution",
                "aggregation",
                "quality",
                "sourceFile",
            ]
        )

        for row in rows:
            value = getattr(row, metric)

            writer.writerow(
                [
                    station,
                    station_code,
                    row.observed_date.isoformat(),
                    metric,
                    value,
                    unit,
                    provider,
                    "daily",
                    "daily_mean",
                    "official",
                    source_file,
                ]
            )


def main() -> int:
    args = parse_args()

    if not args.pdf.exists():
        print(f"PDF not found: {args.pdf}", file=sys.stderr)
        return 1

    text = extract_text(args.pdf)
    rows = parse_rows(text)

    if not rows:
        print("No daily rows found", file=sys.stderr)
        return 1

    years = sorted({row.observed_date.year for row in rows})

    if len(years) != 1:
        print(f"Expected one year, found: {years}", file=sys.stderr)
        return 1

    year = years[0]
    unique_dates = {row.observed_date for row in rows}
    duplicates = len(rows) - len(unique_dates)

    expected_days = 366 if date(year, 12, 31).timetuple().tm_yday == 366 else 365
    missing_days = expected_days - len(unique_dates)

    metrics = [
        ("water_level", "cm"),
        ("water_discharge", "m3/s"),
        ("water_temperature", "C"),
    ]

    outputs = {}

    for metric, unit in metrics:
        output_path = (
            args.output_dir
            / f"{args.station_code}-{metric.replace('_', '-')}-{year}.csv"
        )

        write_metric_csv(
            output_path,
            rows,
            args.station,
            args.station_code,
            args.provider,
            args.pdf.name,
            metric,
            unit,
        )

        outputs[metric] = str(output_path)

    report = {
        "sourceFile": args.pdf.name,
        "station": args.station,
        "stationCode": args.station_code,
        "year": year,
        "rowsExtracted": len(rows),
        "uniqueDates": len(unique_dates),
        "duplicates": duplicates,
        "missingDays": missing_days,
        "coverageFrom": min(unique_dates).isoformat(),
        "coverageTo": max(unique_dates).isoformat(),
        "minimumLevelCm": min(row.water_level for row in rows),
        "maximumLevelCm": max(row.water_level for row in rows),
        "outputs": outputs,
    }

    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(
        json.dumps(report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    print(f"Station: {args.station}")
    print(f"Year: {year}")
    print(f"Rows: {len(rows)}")
    print(f"Unique dates: {len(unique_dates)}")
    print(f"Missing days: {missing_days}")
    print(f"Duplicates: {duplicates}")
    print(
        f"Coverage: {report['coverageFrom']} → {report['coverageTo']}"
    )
    print(
        f"Level range: {report['minimumLevelCm']} → "
        f"{report['maximumLevelCm']} cm"
    )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
