#!/usr/bin/env bash
# VFX 메이커 Windows 설치 프로그램(release/VFXMaker-Setup.exe)을 만든다.
# 사전 준비: nsis (apt-get install nsis), 먼저 ./desktop/build-windows.sh 로 exe 를 빌드해 둘 것.
set -euo pipefail
cd "$(dirname "$0")"
[ -f ../release/windows-x64/vfxmaker.exe ] || { echo "먼저 ./desktop/build-windows.sh 를 실행하세요" >&2; exit 1; }
python3 -I make-icon.py
VERSION=$(grep -m1 '^version' Cargo.toml | sed -E 's/.*"([0-9]+\.[0-9]+\.[0-9]+)".*/\1/')
makensis -V2 -INPUTCHARSET UTF8 "-DVERSION=${VERSION}" installer.nsi
ls -la ../release/VFXMaker-Setup.exe
