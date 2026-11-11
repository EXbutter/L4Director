Set WshShell = CreateObject("WScript.Shell")
scriptDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = scriptDir
' 使用 cmd /c + 日志重定向，确保路径正确
WshShell.Run "cmd /c python main.py --port 8288 > backend_output.log 2>&1", 0, False
