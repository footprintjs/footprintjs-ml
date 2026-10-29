#!/usr/bin/env python3
"""Standalone JSON-lines runner for the reusable plugin runtime."""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from footprint_ml_adapter.runtime import serve

if __name__ == "__main__":
    serve()
