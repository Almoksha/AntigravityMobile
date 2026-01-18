@echo off
title Stop Antigravity Mobile Server
echo.
echo ==========================================
echo   Stopping Antigravity Mobile Server
echo ==========================================
echo.

REM Find the process using port 3001
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3001 ^| findstr LISTENING') do (
    echo Found server process with PID: %%a
    taskkill /PID %%a /F >nul 2>&1
    if %errorlevel% equ 0 (
        echo Server stopped successfully!
    ) else (
        echo Failed to stop process %%a
    )
    goto :done
)

echo No server found running on port 3001.

:done
echo.
echo Press any key to close...
pause >nul
