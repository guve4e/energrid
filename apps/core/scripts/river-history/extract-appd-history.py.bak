#!/usr/bin/env python3

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import xml.etree.ElementTree as ET
from collections import defaultdict
from dataclasses import dataclass
from datetime import date
from pathlib import Path


YEAR_MIN = 1900
YEAR_MAX = 2100
YEAR_PATTERN = re.compile(r"^\d{4}$")
INTEGER_PATTERN = re.compile(r"^-?\d+$")


@dataclass(frozen=True)
class TextNode:
    top: int
    left: int
    width: int
    text: str

    @property
    def center_x(self) -> float:
        return self.left + self.width / 2


@dataclass(frozen=True)
class Observation:
    station: str
    station_code: str
    observed_date: date
    metric: str
    value: int
    unit: str
    provider: str
    resolution: str
    aggregation: str
    quality: str
    source_file: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Extract APPD daily historical river data from pdftohtml XML."
    )
    parser.add_argument("--xml", required=True, type=Path)
    parser.add_argument("--station", required=True)
    parser.add_argument("--station-code", required=True)
    parser.add_argument("--source-file", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--metric", default="water_level")
    parser.add_argument("--unit", default="cm")
    parser.add_argument("--provider", default="appd-bg")
    parser.add_argument("--aggregation", default="daily_observation")
    parser.add_argument("--quality", default="official")
    parser.add_argument(
        "--year-start",
        type=int,
        default=1936,
    )
    parser.add_argument(
        "--year-end",
        type=int,
        default=2019,
    )
    return parser.parse_args()


def parse_int(value: str) -> int | None:
    value = value.strip()

    if not INTEGER_PATTERN.fullmatch(value):
        return None

    return int(value)


def load_pages(xml_path: Path) -> list[list[TextNode]]:
    root = ET.parse(xml_path).getroot()
    pages: list[list[TextNode]] = []

    for page in root.findall("page"):
        nodes: list[TextNode] = []

        for element in page.findall("text"):
            raw_text = "".join(element.itertext()).strip()

            if not raw_text:
                continue

            nodes.append(
                TextNode(
                    top=int(element.attrib["top"]),
                    left=int(element.attrib["left"]),
                    width=int(element.attrib.get("width", "0")),
                    text=raw_text,
                )
            )

        pages.append(nodes)

    return pages


def group_by_top(nodes: list[TextNode], tolerance: int = 2) -> list[list[TextNode]]:
    groups: list[list[TextNode]] = []

    for node in sorted(nodes, key=lambda item: (item.top, item.left)):
        if not groups:
            groups.append([node])
            continue

        current_top = round(
            sum(item.top for item in groups[-1]) / len(groups[-1])
        )

        if abs(node.top - current_top) <= tolerance:
            groups[-1].append(node)
        else:
            groups.append([node])

    return groups


def identify_year_columns(
    nodes: list[TextNode],
    year_start: int,
    year_end: int,
) -> dict[int, float]:
    candidates: dict[int, list[TextNode]] = defaultdict(list)

    for node in nodes:
        if not YEAR_PATTERN.fullmatch(node.text):
            continue

        year = int(node.text)

        if year_start <= year <= year_end:
            candidates[year].append(node)

    columns: dict[int, float] = {}

    for year in range(year_start, year_end + 1):
        year_nodes = candidates.get(year, [])

        if not year_nodes:
            continue

        # The year header is normally the uppermost occurrence on each page.
        header = min(year_nodes, key=lambda item: item.top)
        columns[year] = header.center_x

    return columns


def nearest_year(
    center_x: float,
    year_columns: dict[int, float],
    max_distance: float = 24,
) -> int | None:
    if not year_columns:
        return None

    year, distance = min(
        (
            (year, abs(center_x - column_x))
            for year, column_x in year_columns.items()
        ),
        key=lambda item: item[1],
    )

    if distance > max_distance:
        return None

    return year


def extract_observations(
    pages: list[list[TextNode]],
    args: argparse.Namespace,
) -> tuple[list[Observation], list[dict[str, object]]]:
    observations: list[Observation] = []
    rejected_rows: list[dict[str, object]] = []

    shared_year_columns: dict[int, float] = {}

    for nodes in pages:
        candidate_columns = identify_year_columns(
            nodes,
            args.year_start,
            args.year_end,
        )

        if len(candidate_columns) > len(shared_year_columns):
            shared_year_columns = candidate_columns

    if not shared_year_columns:
        raise ValueError("No year header columns found anywhere in the PDF")

    for page_number, nodes in enumerate(pages, start=1):
        page_year_columns = identify_year_columns(
            nodes,
            args.year_start,
            args.year_end,
        )

        year_columns = (
            page_year_columns
            if len(page_year_columns) == len(shared_year_columns)
            else shared_year_columns
        )

        for row in group_by_top(nodes):
            row = sorted(row, key=lambda item: item.left)

            left_numeric = [
                node
                for node in row
                if node.left < 200 and parse_int(node.text) is not None
            ]

            if len(left_numeric) < 2:
                continue

            day = parse_int(left_numeric[0].text)
            month = parse_int(left_numeric[1].text)

            if day is None or month is None:
                continue

            if not (1 <= day <= 31 and 1 <= month <= 12):
                continue

            values_found = 0

            for node in row:
                if node.left < 190:
                    continue

                value = parse_int(node.text)

                if value is None:
                    continue

                year = nearest_year(node.center_x, year_columns)

                if year is None:
                    continue

                try:
                    observed_date = date(year, month, day)
                except ValueError:
                    # Expected for dates such as 29 February in non-leap years.
                    continue

                observations.append(
                    Observation(
                        station=args.station,
                        station_code=args.station_code,
                        observed_date=observed_date,
                        metric=args.metric,
                        value=value,
                        unit=args.unit,
                        provider=args.provider,
                        resolution="daily",
                        aggregation=args.aggregation,
                        quality=args.quality,
                        source_file=args.source_file,
                    )
                )
                values_found += 1

            if values_found == 0:
                rejected_rows.append(
                    {
                        "page": page_number,
                        "top": row[0].top,
                        "day": day,
                        "month": month,
                        "reason": "Date row contained no mapped values",
                    }
                )

    return observations, rejected_rows


def validate(
    observations: list[Observation],
    year_start: int,
    year_end: int,
) -> dict[str, object]:
    by_key: dict[tuple[str, date], list[Observation]] = defaultdict(list)

    for observation in observations:
        by_key[(observation.station_code, observation.observed_date)].append(
            observation
        )

    duplicates = {
        f"{station_code}:{observed_date.isoformat()}": len(rows)
        for (station_code, observed_date), rows in by_key.items()
        if len(rows) > 1
    }

    unique_observations = [
        rows[0]
        for rows in by_key.values()
    ]

    values = [observation.value for observation in unique_observations]
    dates = [observation.observed_date for observation in unique_observations]

    expected_dates = {
        date(year, month, day)
        for year in range(year_start, year_end + 1)
        for month in range(1, 13)
        for day in range(1, 32)
        if is_valid_date(year, month, day)
    }

    actual_dates = set(dates)
    missing_dates = sorted(expected_dates - actual_dates)

    annual_counts: dict[int, int] = defaultdict(int)

    for observed_date in actual_dates:
        annual_counts[observed_date.year] += 1

    return {
        "rows_extracted": len(observations),
        "unique_rows": len(unique_observations),
        "duplicate_dates": duplicates,
        "coverage_from": min(dates).isoformat() if dates else None,
        "coverage_to": max(dates).isoformat() if dates else None,
        "minimum_value": min(values) if values else None,
        "maximum_value": max(values) if values else None,
        "negative_value_count": sum(1 for value in values if value < 0),
        "missing_date_count": len(missing_dates),
        "missing_dates_sample": [
            item.isoformat() for item in missing_dates[:100]
        ],
        "annual_counts": dict(sorted(annual_counts.items())),
    }


def is_valid_date(year: int, month: int, day: int) -> bool:
    try:
        date(year, month, day)
        return True
    except ValueError:
        return False


def write_csv(
    output_path: Path,
    observations: list[Observation],
) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)

    unique: dict[tuple[str, date], Observation] = {}

    for observation in observations:
        key = (observation.station_code, observation.observed_date)

        if key in unique and unique[key].value != observation.value:
            raise ValueError(
                f"Conflicting duplicate for {key}: "
                f"{unique[key].value} vs {observation.value}"
            )

        unique[key] = observation

    rows = sorted(
        unique.values(),
        key=lambda item: item.observed_date,
    )

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
            writer.writerow(
                [
                    row.station,
                    row.station_code,
                    row.observed_date.isoformat(),
                    row.metric,
                    row.value,
                    row.unit,
                    row.provider,
                    row.resolution,
                    row.aggregation,
                    row.quality,
                    row.source_file,
                ]
            )


def main() -> int:
    args = parse_args()

    if not args.xml.exists():
        print(f"XML file does not exist: {args.xml}", file=sys.stderr)
        return 1

    pages = load_pages(args.xml)
    observations, rejected_rows = extract_observations(pages, args)
    report = validate(observations, args.year_start, args.year_end)
    report["rejected_rows"] = rejected_rows

    write_csv(args.output, observations)

    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(
        json.dumps(report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    print(f"Pages: {len(pages)}")
    print(f"Extracted rows: {report['rows_extracted']}")
    print(f"Unique rows: {report['unique_rows']}")
    print(f"Coverage: {report['coverage_from']} → {report['coverage_to']}")
    print(f"Missing dates: {report['missing_date_count']}")
    print(f"Duplicate dates: {len(report['duplicate_dates'])}")
    print(f"Minimum: {report['minimum_value']} {args.unit}")
    print(f"Maximum: {report['maximum_value']} {args.unit}")
    print(f"CSV: {args.output}")
    print(f"Report: {args.report}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
