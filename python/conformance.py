#!/usr/bin/env python3
"""Portable CLI wrapper; no PYTHONPATH configuration is required."""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from footprint_ml_adapter.conformance import main

if __name__ == "__main__":
    main()
