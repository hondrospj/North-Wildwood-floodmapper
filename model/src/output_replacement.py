"""Preserve a completed model directory until its staged replacement succeeds."""
from __future__ import annotations

import os
from pathlib import Path
import shutil


def previous_directory(destination: Path) -> Path:
    return destination.with_name(f".{destination.name}.previous")


def recover_directory(destination: Path) -> None:
    previous = previous_directory(destination)
    if previous.exists() and not destination.exists():
        os.replace(previous, destination)


def promote_directory(staged: Path, destination: Path) -> None:
    recover_directory(destination)
    previous = previous_directory(destination)
    if previous.exists():
        shutil.rmtree(previous)
    if destination.exists():
        os.replace(destination, previous)
    try:
        os.replace(staged, destination)
    except BaseException:
        recover_directory(destination)
        raise
    if previous.exists():
        shutil.rmtree(previous)
