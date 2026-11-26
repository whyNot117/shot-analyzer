@echo off
rem 在最小化的窗口里启动本地服务，然后自动打开网页。
rem 要停止服务：关闭那个最小化的 "shot-analyzer-server" 窗口（也可以在窗口里按 Ctrl+C）。
rem 如果 5500 端口已经在跑本目录，浏览器会直接用它。
cd /d "%~dp0"
start "shot-analyzer-server" /min cmd /c "node server.mjs"
ping -n 2 127.0.0.1 >nul
start "" "http://127.0.0.1:5500/"
