#!/usr/bin/env python3
"""Use an explicitly configured or project-local IPC runtime when available."""
import os
from pathlib import Path
import sys

root=Path(__file__).resolve().parents[1]
configured=os.environ.get('SILK_IPC_PYTHON')
candidate=Path(configured) if configured else root/'.venv-ipc'/'bin'/'python'
python=str(candidate) if candidate.is_file() else sys.executable
os.environ.setdefault('TBB_NUM_THREADS','1')
os.execv(python,[python,str(root/'scripts'/'server.py'),*sys.argv[1:]])
