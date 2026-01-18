@echo off
title Antigravity Mobile
:: Antigravity Mobile Launcher - Windows
:: Double-click this file to start everything

cd /d "%~dp0"

echo.
echo ==========================================
echo   Antigravity Mobile Server
echo ==========================================
echo.

:: Check if node is installed
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo Node.js is not installed on your system.
    echo.
    echo Would you like to install it automatically?
    echo This requires Windows 10/11 with winget.
    echo.
    choice /C YN /M "Install Node.js now"
    if errorlevel 2 goto :nonode
    if errorlevel 1 goto :installnode
)
goto :checkmodules

:installnode
echo.
echo Installing Node.js via winget...
echo This may take a few minutes...
echo.
winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
if %errorlevel% neq 0 (
    echo.
    echo ERROR: Failed to install Node.js via winget.
    echo Please install manually from https://nodejs.org/
    pause
    exit /b 1
)
echo.
echo Node.js installed successfully!
echo Please close this window and run the script again.
pause
exit /b 0

:nonode
echo.
echo Please install Node.js manually from https://nodejs.org/
echo Then run this script again.
pause
exit /b 1

:checkmodules
:: Check if node_modules exists
if not exist "node_modules\" (
    echo First time setup - Installing dependencies...
    echo This may take a minute...
    echo.
    call npm install
    if %errorlevel% neq 0 (
        echo.
        echo ERROR: Failed to install dependencies!
        pause
        exit /b 1
    )
    echo.
    echo Dependencies installed successfully!
    echo.
)

echo Starting server...
echo.
node launcher.mjs
pause
