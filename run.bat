@echo off
title YouTube Frame Extractor
color 0A

echo =========================================
echo    YouTube Frame Extractor
echo =========================================
echo.

:: Check if Node.js is installed
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Node.js is not installed or not in PATH!
    echo Please install Node.js from https://nodejs.org/
    pause
    exit /b 1
)

:: Check if dependencies are installed
if not exist "node_modules" (
    echo Installing dependencies...
    call npm install
    if %ERRORLEVEL% NEQ 0 (
        echo [ERROR] Failed to install dependencies!
        pause
        exit /b 1
    )
    echo.
)

echo Starting server...
echo Opening http://localhost:3000 in your browser...
echo.

:: Open the browser after a small delay
start "" /b cmd /c "timeout /t 2 >nul && start http://localhost:3000"

:: Start the Node.js server
node server.js

:: If the server crashes or is stopped, wait before closing the window
echo.
echo Server stopped. Press any key to close...
pause >nul
