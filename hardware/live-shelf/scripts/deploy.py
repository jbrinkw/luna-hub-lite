#!/usr/bin/env python3
"""Deploy the Live Shelf server to the Pi via paramiko.

Mirrors the pattern used by `hardware/fridge-cam/.../deploy.py` — walks
the local tree, skips venv/cache/data directories, and SFTPs the
remainder to the Pi. Does NOT install dependencies; run the one-liner
printed at the end or ssh in and `pip install` manually.
"""

from __future__ import annotations

import argparse
import os
import posixpath
import stat
import sys
from pathlib import Path

import paramiko  # type: ignore[import-untyped]

HOST = "192.168.0.181"
USER = "jeremy"
PASS = "jeremy"

LOCAL_SRC = Path(__file__).resolve().parent.parent  # hardware/live-shelf
REMOTE_DST = "/home/jeremy/live-shelf"

# Directories we never ship (venv binaries, caches, local DB + frames).
EXCLUDE_DIR_NAMES = {
    ".venv",
    "__pycache__",
    ".git",
    ".pytest_cache",
    ".mypy_cache",
    "node_modules",
}

# File basenames we never ship by default. `.env` is managed on the Pi —
# operators often rotate the Anthropic API key there and a naive deploy
# would silently clobber it with the local (possibly stale) copy. Override
# via --include-env if you really want to push the local version.
EXCLUDE_FILE_NAMES = {
    ".env",
}

# Top-level paths (relative to LOCAL_SRC) that get their directory
# created on the Pi but whose contents we don't ship.
EXCLUDE_CONTENTS_TOP = {
    "server/data",
}


def _ssh_client() -> paramiko.SSHClient:
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(
        HOST,
        username=USER,
        password=PASS,
        timeout=10,
        allow_agent=False,
        look_for_keys=False,
    )
    return client


def _run(client: paramiko.SSHClient, cmd: str, *, check: bool = False) -> int:
    _, out, err = client.exec_command(cmd, timeout=300)
    code = out.channel.recv_exit_status()
    if code != 0:
        sys.stdout.write(out.read().decode(errors="replace"))
        sys.stderr.write(err.read().decode(errors="replace"))
        if check:
            raise RuntimeError(f"remote command failed ({code}): {cmd}")
    return code


def _sftp_mkdirs(sftp, remote_dir: str) -> None:
    parts = remote_dir.strip("/").split("/")
    cur = ""
    for p in parts:
        cur = cur + "/" + p
        try:
            sftp.stat(cur)
        except IOError:
            sftp.mkdir(cur)


def _sftp_transfer(
    sftp,
    local: Path,
    remote: str,
    root: Path,
    *,
    excluded_file_names: frozenset[str] | set[str] = frozenset(EXCLUDE_FILE_NAMES),
) -> int:
    """Recursively push ``local`` to ``remote``. Returns bytes copied."""
    _sftp_mkdirs(sftp, remote)
    total = 0
    for entry in sorted(os.listdir(local)):
        lp = local / entry
        rp = posixpath.join(remote, entry)
        rel = lp.relative_to(root).as_posix()
        if lp.is_dir():
            if entry in EXCLUDE_DIR_NAMES:
                continue
            # Create an empty dir but skip contents if it's an EXCLUDE_CONTENTS_TOP.
            if rel in EXCLUDE_CONTENTS_TOP:
                try:
                    sftp.stat(rp)
                except IOError:
                    sftp.mkdir(rp)
                continue
            total += _sftp_transfer(
                sftp, lp, rp, root, excluded_file_names=excluded_file_names
            )
        else:
            if entry in excluded_file_names:
                print(f"  skip {rel} (manage on Pi directly)")
                continue
            size = lp.stat().st_size
            print(f"  put {lp} -> {rp} ({size:,}B)")
            sftp.put(str(lp), rp)
            total += size
    return total


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="connect + list the local tree but don't transfer",
    )
    parser.add_argument(
        "--include-env",
        action="store_true",
        help=(
            "push the local .env too (by default .env is skipped so a Pi-side "
            "rotation of the Anthropic API key isn't clobbered)"
        ),
    )
    args = parser.parse_args(argv)

    excluded_file_names = (
        frozenset() if args.include_env else frozenset(EXCLUDE_FILE_NAMES)
    )

    print(f"Local source: {LOCAL_SRC}")
    print(f"Remote dest:  {USER}@{HOST}:{REMOTE_DST}")

    if args.dry_run:
        for root, dirs, files in os.walk(LOCAL_SRC):
            dirs[:] = [d for d in dirs if d not in EXCLUDE_DIR_NAMES]
            for f in files:
                if f in excluded_file_names:
                    print(f"(skip) {os.path.join(root, f)}")
                    continue
                print(os.path.join(root, f))
        return 0

    print(f"Connecting to {USER}@{HOST}…")
    client = _ssh_client()
    try:
        _run(client, f"mkdir -p {REMOTE_DST}", check=True)
        sftp = client.open_sftp()
        try:
            total = _sftp_transfer(
                sftp,
                LOCAL_SRC,
                REMOTE_DST,
                LOCAL_SRC,
                excluded_file_names=excluded_file_names,
            )
        finally:
            sftp.close()
        print(f"Transferred {total:,} bytes")
        print()
        print("Next steps (run on the Pi):")
        print(
            f"  ssh {USER}@{HOST} 'cd {REMOTE_DST} && "
            "python3 -m pip install --break-system-packages -r server/requirements.txt'"
        )
        print(f"  ssh {USER}@{HOST} 'cd {REMOTE_DST} && python3 -m server.app'")
    finally:
        client.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
