@echo off
setlocal EnableExtensions
rem Portable pnpm shim for the Windows end-to-end control instance.
rem
rem Resolution order:
rem   1. %PNPM_EXE%   explicit path to a real pnpm (.exe, .cmd or .cjs)
rem   2. pnpm         the first pnpm on PATH that is not this shim
rem   3. stderr       an actionable error, exit code 1
rem
rem The Linux CI job writes its own POSIX `pnpm` shim, so this file only covers
rem Windows checkouts and must never contain machine-specific absolute paths.

if defined PNPM_EXE goto use_pnpm_exe

set "PNPM_CMD="
for /f "delims=" %%I in ('where pnpm 2^>nul') do (
  if not defined PNPM_CMD if /I not "%%~fI"=="%~f0" set "PNPM_CMD=%%~fI"
)
if not defined PNPM_CMD goto not_found

if /I "%PNPM_CMD:~-4%"==".cjs" (
  node "%PNPM_CMD%" %*
  exit /b %ERRORLEVEL%
)
call "%PNPM_CMD%" %*
exit /b %ERRORLEVEL%

:use_pnpm_exe
if not exist "%PNPM_EXE%" (
  >&2 echo [e2e/control/bin/pnpm.cmd] PNPM_EXE is set but not found: %PNPM_EXE%
  >&2 echo   Point PNPM_EXE at the pnpm executable, or unset it to use PATH.
  exit /b 1
)
if /I "%PNPM_EXE:~-4%"==".cjs" (
  node "%PNPM_EXE%" %*
  exit /b %ERRORLEVEL%
)
call "%PNPM_EXE%" %*
exit /b %ERRORLEVEL%

:not_found
>&2 echo.
>&2 echo [e2e/control/bin/pnpm.cmd] pnpm was not found.
>&2 echo   The Windows E2E control instance needs pnpm 11 and Node 24 to install
>&2 echo   @deepseek-ai/dsh locally. Fix it with one of:
>&2 echo.
>&2 echo     1. Put pnpm on PATH:  corepack enable ^&^& corepack prepare pnpm@11 --activate
>&2 echo     2. Point this shim at a pnpm:  set PNPM_EXE=C:\path\to\pnpm.cmd
>&2 echo.
>&2 echo   Then re-run the E2E preparation step.
exit /b 1
