@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set "AOS_PROJECT_DIR=%~dp0project"
set "PATH=%~dp0tools\platform-tools;%PATH%"
set "AOS_PEN_SKIP=1"
set "AOS_PEN_NO_INSTALL=1"
set "AOS_LLM_FROM_CENTER=1"
set "UV_PYTHON=3.12"
set "UV_SYSTEM_CERTS=1"
if not exist "deps\win32-site-packages.zip" (
  echo [offline] 缺少 deps\win32-site-packages.zip。
  exit /b 2
)
if not exist "artemis\.venv\Scripts\python.exe" (
  echo [offline] 创建 Python 3.12 venv...
  uv venv --python 3.12 "artemis\.venv"
)
if exist "artemis\.venv\Scripts\python.exe" (
  "artemis\.venv\Scripts\python.exe" -c "import sys;print('ok' if sys.version_info[:2]==(3,12) else 'no')" > "%TEMP%\aos-venv-version.txt" 2>nul
  findstr /x "ok" "%TEMP%\aos-venv-version.txt" >nul
  if errorlevel 1 (
    echo [offline] venv Python 不是 3.12；重建 venv...
    rmdir /s /q "artemis\.venv"
    uv venv --python 3.12 "artemis\.venv"
  )
  del "%TEMP%\aos-venv-version.txt" >nul 2>&1
)
if not exist "artemis\.venv\Scripts\python.exe" (
  echo [offline] venv 创建失败；确认 Python 3.12 可用，运行 uv python find 3.12。
  exit /b 2
)
echo [offline] 解压 Windows 依赖，解压后约 850MB...
if not exist "artemis\.venv\Lib\site-packages" mkdir "artemis\.venv\Lib\site-packages"
powershell -NoProfile -Command "Expand-Archive -Force 'deps\win32-site-packages.zip' 'artemis\.venv\Lib\site-packages'"
if not exist "artemis\.venv\Lib\site-packages\pydantic\__init__.py" (
  echo [offline] 依赖解压失败。
  exit /b 2
)
xcopy /E /I /Y "artemis\packages\artemis-client\src\artemis_client" "artemis\.venv\Lib\site-packages\artemis_client" >nul
node -e "const fs=require('fs'),crypto=require('crypto');const h=crypto.createHash('sha256').update(fs.readFileSync('artemis/uv.lock')).digest('hex');fs.writeFileSync('artemis/.venv/.aos-deps.json',JSON.stringify({schema:1,lockSha256:h,pythonVersion:'3.12',source:{type:'bundle',url:'offline:win32-site-packages.zip'},installedAt:new Date().toISOString()},null,2)+'\n')"
echo [offline] 依赖安装完成。
node dist\cli.js doctor
exit /b 0
