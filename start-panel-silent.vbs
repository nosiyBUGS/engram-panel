Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = folder

On Error Resume Next
shell.Run "pythonw.exe """ & folder & "\server.py""", 0, False
If Err.Number <> 0 Then
  Err.Clear
  shell.Run "pyw.exe """ & folder & "\server.py""", 0, False
End If
