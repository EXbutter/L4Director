Set WshShell = CreateObject("WScript.Shell")
scriptDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = scriptDir

' Step 1: 启动 Vite 开发服务器（隐藏窗口）
WshShell.Run "cmd /c npx vite > vite.log 2>&1", 0, False

' Step 2: 等 Vite 准备好
WScript.Sleep 4000

' Step 3: 启动 Electron（正常显示窗口）
WshShell.Run "cmd /c npx electron . > electron.log 2>&1", 1, False
