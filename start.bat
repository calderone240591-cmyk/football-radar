@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo  Футбол Радар — локальний сервер
echo  -------------------------------
echo  На ноутбуці:  http://localhost:8080
echo.
echo  Щоб зупинити сервер, закрийте це вікно.
echo.
start "" http://localhost:8080
python -m http.server 8080 --bind 127.0.0.1
