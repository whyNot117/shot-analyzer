@echo off
rem Start the local test server (minimized), then open the site in the browser.
rem To stop the server, close the minimized "shot-analyzer-server" window.
rem If port 5500 is already serving this folder, the browser just uses that one.
cd /d "%~dp0"
start "shot-analyzer-server" /min cmd /c "node server.mjs"
timeout /t 1 /nobreak >nul
start "" "http://127.0.0.1:5500/"
