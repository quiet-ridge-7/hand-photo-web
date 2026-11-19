@echo off
rem Hand photo app: start a local web server (this PC only) and open it in the browser.
rem Stop: press Ctrl+C in this window, then close it.
set PORT=8784
cd /d "%~dp0"
echo Open: http://localhost:%PORT%/
start "" "http://localhost:%PORT%/"
python -m http.server %PORT% --bind 127.0.0.1
