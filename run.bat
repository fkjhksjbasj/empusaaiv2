@echo off
title PolyWhale v2
cd /d "%~dp0"

:loop
echo [%date% %time%] Starting PolyWhale... (output in data\bot.log)
node server.js >> data\bot.log 2>&1
echo [%date% %time%] Process exited! Restarting in 3s...
timeout /t 3 /nobreak >nul
goto loop
