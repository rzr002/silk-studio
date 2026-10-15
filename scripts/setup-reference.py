#!/usr/bin/env python3
"""Install pinned open-source reference dependencies in the project venv."""
from pathlib import Path
import subprocess
import sys
import venv

root=Path(__file__).resolve().parents[1]
environment=root/'.venv-ipc'
venv.EnvBuilder(with_pip=True).create(environment)
subprocess.run([str(environment/'bin'/'python'),'-m','pip','--isolated','--disable-pip-version-check','install','--index-url','https://pypi.org/simple','--only-binary=:all:','-r',str(root/'scripts'/'ipc-probe.requirements.txt')],check=True)
print('本地 IPC 依赖已安装。运行 npm start，检查 /api/health 后再执行整袜验证。')
