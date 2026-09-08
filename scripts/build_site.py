#!/usr/bin/env python3
"""Build a dependency-free, project-subpath-safe GitHub Pages artifact."""
from __future__ import annotations

import hashlib
import shutil
import subprocess
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "_site"


class AssetLinks(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.links: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        if tag == "script" and values.get("src"):
            self.links.append(values["src"])
        if tag == "link" and values.get("rel") == "stylesheet" and values.get("href"):
            self.links.append(values["href"])


def main() -> None:
    subprocess.run([sys.executable, "build.py"], cwd=ROOT, check=True)
    if SITE.is_symlink():
        raise RuntimeError("Refusing to replace a symlinked _site directory")
    if SITE.exists():
        shutil.rmtree(SITE)
    SITE.mkdir()
    # Explicit allow-list: never publish .git, workflows, tests, or local data.
    for name in ("index.html", "editor.html", "styles.css", "Vellum.html", "LICENSE"):
        if (ROOT / name).exists():
            shutil.copy2(ROOT / name, SITE / name)
    shutil.copytree(ROOT / "src", SITE / "src")
    if (ROOT / "releases").exists():
        shutil.copytree(ROOT / "releases", SITE / "releases")
    (SITE / ".nojekyll").write_text("", encoding="utf-8")
    parser = AssetLinks()
    target_html = (SITE / "editor.html") if (SITE / "editor.html").exists() else (SITE / "index.html")
    parser.feed(target_html.read_text(encoding="utf-8"))
    if not parser.links:
        raise RuntimeError("No editor assets found in index.html")
    for link in parser.links:
        url = urlsplit(link)
        if url.scheme or url.netloc or url.path.startswith("/"):
            raise RuntimeError(f"Asset must be local and project-relative: {link}")
        path = (SITE / unquote(url.path)).resolve()
        if not path.is_relative_to(SITE) or not path.is_file():
            raise RuntimeError(f"Missing or out-of-tree asset: {link}")
    files = sorted(p for p in SITE.rglob("*") if p.is_file())
    manifest = "".join(
        f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.relative_to(SITE).as_posix()}\n"
        for path in files
    )
    (SITE / "SHA256SUMS").write_text(manifest, encoding="utf-8")
    print(f"Built {SITE}: {len(files) + 1} files; all editor asset URLs are relative.")


if __name__ == "__main__":
    main()
