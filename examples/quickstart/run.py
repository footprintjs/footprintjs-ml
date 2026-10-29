"""Convenience launcher: keep your trainer in Python; delegate workflow capture to Node."""
import os
from pathlib import Path
import subprocess
import sys

if __name__ == '__main__':
    node = os.environ.get('FOOTPRINT_NODE', 'node')
    cli = Path(__file__).with_name('cli.mjs')
    raise SystemExit(subprocess.call([node, str(cli), 'demo', '--python', sys.executable, *sys.argv[1:]]))
