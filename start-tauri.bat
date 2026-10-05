@echo off
cd /d D:\claudeProject\project\rag-agent
set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222
call npm run tauri:dev
