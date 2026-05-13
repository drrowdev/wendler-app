#!/usr/bin/env python3
"""
Sensitive-pattern scanner. Blocks accidental leaks of pre-public-flip
identifiers (owner emails, infrastructure resource names, home directory
paths) from re-entering this repo.

Loads its forbidden-pattern list, in priority order:
  1. $WENDLER_PATTERNS_FILE env var (explicit override, used locally / by tests)
  2. .git/info/sensitive-patterns.txt (operator's master list, never tracked)
  3. $SENSITIVE_PATTERNS env var (newline-separated; used by CI from a GHA secret)

Matches case-insensitively. Reports findings with the matched pattern
REDACTED (first 3 chars + length) so failure output itself doesn't leak.

Modes:
  --staged         scan staged blobs only (pre-commit hook)
  --all            scan the entire tracked tree (pre-push hook + CI)
  --commit-range A..B  scan added lines across a commit range
  --files <p ...>  scan an explicit file list

Exit code:
  0  clean
  1  at least one match
  2  configuration / runtime error
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Iterable


def load_patterns() -> list[str]:
    env_file = os.environ.get("WENDLER_PATTERNS_FILE")
    if env_file:
        p = Path(env_file)
        if p.is_file():
            return _read_pattern_file(p)
        print(
            f"check_sensitive_patterns: WENDLER_PATTERNS_FILE={env_file} not found",
            file=sys.stderr,
        )
        sys.exit(2)

    repo_root = _repo_root()
    if repo_root is not None:
        local = repo_root / ".git" / "info" / "sensitive-patterns.txt"
        if local.is_file():
            return _read_pattern_file(local)

    env_patterns = os.environ.get("SENSITIVE_PATTERNS")
    if env_patterns:
        return _parse_pattern_text(env_patterns)

    print(
        "check_sensitive_patterns: no pattern list configured (this is fine "
        "for forks / fresh clones)",
        file=sys.stderr,
    )
    return []


def _read_pattern_file(path: Path) -> list[str]:
    return _parse_pattern_text(path.read_text(encoding="utf-8"))


def _parse_pattern_text(text: str) -> list[str]:
    out: list[str] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        out.append(line)
    return out


def _repo_root() -> Path | None:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            check=True,
            capture_output=True,
            text=True,
        )
        return Path(result.stdout.strip())
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None


def redact(needle: str) -> str:
    head = needle[:3]
    return f"{head!r}... (len={len(needle)})"


def staged_files() -> list[Path]:
    result = subprocess.run(
        ["git", "diff", "--cached", "--name-only", "--diff-filter=ACMR"],
        check=True,
        capture_output=True,
        text=True,
    )
    return [Path(p) for p in result.stdout.splitlines() if p.strip()]


def all_tracked_files() -> list[Path]:
    result = subprocess.run(
        ["git", "ls-files"], check=True, capture_output=True, text=True
    )
    return [Path(p) for p in result.stdout.splitlines() if p.strip()]


def commit_range_added_lines(rng: str) -> list[tuple[Path, int, str]]:
    result = subprocess.run(
        ["git", "log", "-p", "--unified=0", "--no-color", rng],
        check=True,
        capture_output=True,
        text=True,
    )
    out: list[tuple[Path, int, str]] = []
    cur_path: Path | None = None
    cur_line = 0
    for line in result.stdout.splitlines():
        if line.startswith("+++ b/"):
            cur_path = Path(line[6:])
            continue
        if line.startswith("@@"):
            m = re.search(r"\+(\d+)(?:,\d+)?", line)
            if m:
                cur_line = int(m.group(1))
            continue
        if line.startswith("+") and not line.startswith("+++"):
            if cur_path is not None:
                out.append((cur_path, cur_line, line[1:]))
            cur_line += 1
        elif not line.startswith("-"):
            cur_line += 1
    return out


def scan_text(text: str, patterns: list[re.Pattern[str]]) -> list[str]:
    hits: list[str] = []
    for rx in patterns:
        if rx.search(text):
            hits.append(rx.pattern)
    return hits


def scan_files(files: Iterable[Path], patterns: list[re.Pattern[str]]) -> int:
    failures = 0
    for f in files:
        try:
            text = f.read_text(encoding="utf-8", errors="ignore")
        except (OSError, UnicodeDecodeError):
            continue
        hits = scan_text(text, patterns)
        if hits:
            failures += 1
            print(f"SENSITIVE PATTERN MATCH in {f}:")
            for h in hits:
                print(f"  - {redact(h)}")
    return failures


def scan_staged(patterns: list[re.Pattern[str]]) -> int:
    failures = 0
    for f in staged_files():
        try:
            blob = subprocess.run(
                ["git", "show", f":{f}"],
                check=True,
                capture_output=True,
                text=True,
                errors="ignore",
            ).stdout
        except subprocess.CalledProcessError:
            continue
        hits = scan_text(blob, patterns)
        if hits:
            failures += 1
            print(f"SENSITIVE PATTERN MATCH in staged {f}:")
            for h in hits:
                print(f"  - {redact(h)}")
    return failures


def compile_patterns(raw: list[str]) -> list[re.Pattern[str]]:
    return [re.compile(re.escape(p), re.IGNORECASE) for p in raw]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    g = parser.add_mutually_exclusive_group(required=True)
    g.add_argument("--staged", action="store_true", help="scan staged blobs")
    g.add_argument("--all", action="store_true", help="scan whole tracked tree")
    g.add_argument(
        "--commit-range",
        help="scan added lines in a commit range, e.g. origin/main..HEAD",
    )
    g.add_argument("--files", nargs="+", help="scan explicit file paths")
    args = parser.parse_args(argv)

    raw = load_patterns()
    if not raw:
        return 0
    patterns = compile_patterns(raw)

    if args.staged:
        failures = scan_staged(patterns)
    elif args.all:
        failures = scan_files(all_tracked_files(), patterns)
    elif args.commit_range:
        failures = 0
        added = commit_range_added_lines(args.commit_range)
        by_file: dict[Path, list[tuple[int, str]]] = {}
        for f, n, line in added:
            by_file.setdefault(f, []).append((n, line))
        for f, lines in by_file.items():
            joined = "\n".join(line for _, line in lines)
            hits = scan_text(joined, patterns)
            if hits:
                failures += 1
                print(f"SENSITIVE PATTERN MATCH in {f} (added lines in range):")
                for h in hits:
                    print(f"  - {redact(h)}")
    elif args.files:
        failures = scan_files([Path(p) for p in args.files], patterns)
    else:
        return 2

    if failures:
        print(
            f"\nBLOCKED: {failures} file{'s' if failures != 1 else ''} contain "
            "sensitive patterns. Remove the offending content before committing/pushing.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
