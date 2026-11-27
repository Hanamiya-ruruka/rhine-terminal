@echo off
rem HKCU Run entry for the auto-daily watcher (requires pythonw.exe on PATH, Python 3.11+).
cd /d "%~dp0" || exit /b 1
start "" pythonw.exe "%~dp0auto_daily.py" --watch
