#!/usr/bin/env bash
# Linux/macOS 에서 Windows(x64) 실행 파일을 크로스 컴파일한다.
# 사전 준비: rustup, 그리고 mingw-w64 (예: apt-get install gcc-mingw-w64-x86-64)
set -euo pipefail
cd "$(dirname "$0")/.."

npm run build                                   # 웹 앱 → dist/ (exe 안에 포함됨)
rustup target add x86_64-pc-windows-gnu
export CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER=x86_64-w64-mingw32-gcc
(cd desktop && cargo build --release --target x86_64-pc-windows-gnu)

out=release/windows-x64
mkdir -p "$out"
cp desktop/target/x86_64-pc-windows-gnu/release/sprite3d2d.exe "$out/"
# GNU 타깃은 WebView2Loader.dll 을 exe 옆에서 찾는다
cp "$(find desktop/target/x86_64-pc-windows-gnu/release/build -path '*webview2-com-sys*/out/x64/WebView2Loader.dll' | head -1)" "$out/"
ls -la "$out"
