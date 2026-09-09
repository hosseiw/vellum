#!/usr/bin/env python3
"""Fetch GitHub release and repository traffic metrics for the public dashboard."""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "analytics.json"


def github_get(path: str, token: str) -> Any:
    request = Request(
        f"https://api.github.com{path}",
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "User-Agent": "vellum-analytics",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    with urlopen(request, timeout=20) as response:
        return json.load(response)


def main() -> None:
    repository = os.environ.get("GITHUB_REPOSITORY", "hosseiw/vellum")
    token = os.environ.get("ANALYTICS_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if not token:
        raise SystemExit("ANALYTICS_TOKEN or GITHUB_TOKEN is required")

    releases = github_get(f"/repos/{repository}/releases?per_page=100", token)
    assets = []
    for release in releases:
        for asset in release.get("assets", []):
            assets.append({"name": asset["name"], "downloads": asset["download_count"], "release": release["tag_name"]})
    views = github_get(f"/repos/{repository}/traffic/views", token)
    result = {
        "status": "ok",
        "repository": repository,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "page_views": {"count": views["count"], "uniques": views["uniques"], "period_days": 14},
        "downloads": {"total": sum(asset["downloads"] for asset in assets), "assets": assets},
    }
    OUTPUT.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {OUTPUT}: {result['page_views']['count']} views, {result['downloads']['total']} downloads")


if __name__ == "__main__":
    main()
