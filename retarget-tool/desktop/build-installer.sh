#!/usr/bin/env bash
# 리타깃 툴 Windows 설치 프로그램(release/RetargetTool-Setup.exe)을 만든다.
# 사전 준비: nsis (apt-get install nsis), 먼저 ./desktop/build-windows.sh 로 exe 를 빌드해 둘 것.
set -euo pipefail
cd "$(dirname "$0")"
[ -f ../release/windows-x64/retargettool.exe ] || { echo "먼저 ./desktop/build-windows.sh 를 실행하세요" >&2; exit 1; }
python3 -I make-icon.py
VERSION=$(grep -m1 '^version' Cargo.toml | sed -E 's/.*"([0-9]+\.[0-9]+\.[0-9]+)".*/\1/')
makensis -V2 -INPUTCHARSET UTF8 "-DVERSION=${VERSION}" installer.nsi
ls -la ../release/RetargetTool-Setup.exe
