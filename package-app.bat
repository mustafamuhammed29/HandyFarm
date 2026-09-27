@echo off
echo Building and packaging Shop Device Control Panel...
echo This may take a minute or two.
call npm run build
echo.
echo Packaging complete! Check the "release" folder for the .exe setup file.
pause
