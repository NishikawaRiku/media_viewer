@echo off

if not exist node_modules call npm install
if not exist package-lock.json call npm install

npm start password
pause
