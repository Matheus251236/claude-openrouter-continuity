Option Explicit
Dim fso, shell, root, command, result
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(WScript.ScriptFullName)
command = "node " & Chr(34) & root & "\scripts\verify.mjs" & Chr(34)
On Error Resume Next
result = shell.Run(command, 0, True)
If Err.Number <> 0 Then
  MsgBox "Nao foi possivel iniciar o Node.js. Instale Node.js 22 ou mais recente.", 48, "Claude Continuity"
  WScript.Quit 1
End If
On Error GoTo 0
If fso.FileExists(root & "\runtime\report.html") Then
  shell.Run Chr(34) & root & "\runtime\report.html" & Chr(34), 1, False
Else
  MsgBox "A verificacao nao gerou o relatorio. Consulte scripts/verify.mjs.", 48, "Claude Continuity"
End If
