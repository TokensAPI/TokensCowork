import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve, sep } from 'node:path'

const root = resolve(import.meta.dirname, '..', '..')
const buildRoot = resolve(root, '.build')
const stage = resolve(buildRoot, 'desktop')
const desktop = resolve(stage, 'dsh-plugin-desktop')
const electronExe = process.argv[2]
const runner = resolve(desktop, 'lib', 'windows-acl-runner.js')
const upstreamRunner = resolve(
  desktop,
  'node_modules',
  '@deepseek-ai',
  'dsh-sandbox-windows-acl',
  'lib',
  'runner.js',
)
const powershell = resolve(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
)
const wscript = resolve(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wscript.exe')

if (electronExe === undefined || !existsSync(electronExe)) {
  throw new Error('usage: node build/verify/windows-acl-console-smoke.mjs <electron-exe>')
}
for (const path of [runner, upstreamRunner, powershell, wscript]) {
  if (!existsSync(path)) throw new Error(`windows-acl-console-smoke: missing dependency: ${path}`)
}

mkdirSync(buildRoot, { recursive: true })
const smokeRoot = mkdtempSync(resolve(buildRoot, 'windows-acl-console-smoke-'))
if (!smokeRoot.startsWith(`${buildRoot}${sep}`)) {
  throw new Error(`windows-acl-console-smoke: temp path escaped .build: ${smokeRoot}`)
}

const workspace = resolve(smokeRoot, 'workspace')
const temp = resolve(smokeRoot, 'temp')
const outsideFile = resolve(smokeRoot, 'outside.txt')
const insideFile = resolve(workspace, 'inside.txt')
mkdirSync(workspace)
mkdirSync(temp)

const vbsPath = resolve(smokeRoot, 'run-hidden.vbs')
writeFileSync(vbsPath, `Option Explicit

Function Q(value)
  Q = Chr(34) & Replace(value, Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function

Dim shell, environment, command, index, child, stdoutText, stderrText, fso
Set shell = CreateObject("WScript.Shell")
Set environment = shell.Environment("Process")
environment("ELECTRON_RUN_AS_NODE") = "1"

command = Q(WScript.Arguments(3))
For index = 4 To WScript.Arguments.Count - 1
  command = command & " " & Q(WScript.Arguments(index))
Next

Set child = shell.Exec(command)
stdoutText = child.StdOut.ReadAll()
stderrText = child.StdErr.ReadAll()
Do While child.Status = 0
  WScript.Sleep 10
Loop

Set fso = CreateObject("Scripting.FileSystemObject")
fso.CreateTextFile(WScript.Arguments(0), True).Write stdoutText
fso.CreateTextFile(WScript.Arguments(1), True).Write stderrText
fso.CreateTextFile(WScript.Arguments(2), True).Write CStr(child.ExitCode)
WScript.Quit 0
`, 'utf8')

let runIndex = 0

function runPowerShell(command) {
  runIndex++
  const stdoutPath = resolve(smokeRoot, `stdout-${runIndex}.txt`)
  const stderrPath = resolve(smokeRoot, `stderr-${runIndex}.txt`)
  const exitPath = resolve(smokeRoot, `exit-${runIndex}.txt`)
  const launch = spawnSync(wscript, [
    '//B',
    '//Nologo',
    vbsPath,
    stdoutPath,
    stderrPath,
    exitPath,
    electronExe,
    runner,
    upstreamRunner,
    '--workspace',
    workspace,
    '--temp',
    temp,
    '--mode',
    'workspace-write',
    '--',
    powershell,
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    command,
  ], {
    cwd: workspace,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
  })
  if (launch.error !== undefined) throw launch.error
  if (launch.status !== 0) {
    throw new Error(`windows-acl-console-smoke: wscript failed with ${String(launch.status)}: ${launch.stderr}`)
  }
  const signedExit = Number.parseInt(readFileSync(exitPath, 'utf8').trim(), 10)
  return {
    exitCode: signedExit >>> 0,
    stdout: readFileSync(stdoutPath, 'utf8').trim(),
    stderr: readFileSync(stderrPath, 'utf8').trim(),
  }
}

const psLiteral = value => `'${value.replaceAll("'", "''")}'`

try {
  const output = runPowerShell('Write-Output ok')
  if (output.exitCode !== 0 || output.stdout !== 'ok') {
    throw new Error(`PowerShell 5.1 output failed: ${JSON.stringify(output)}`)
  }

  const inside = runPowerShell(
    `Set-Content -LiteralPath ${psLiteral(insideFile)} -Value inside -ErrorAction Stop; Write-Output inside-ok`,
  )
  if (inside.exitCode !== 0 || inside.stdout !== 'inside-ok' || !existsSync(insideFile)) {
    throw new Error(`workspace write failed: ${JSON.stringify(inside)}`)
  }

  const outside = runPowerShell(
    `try { Set-Content -LiteralPath ${psLiteral(outsideFile)} -Value outside -ErrorAction Stop; exit 0 } catch { exit 13 }`,
  )
  if (outside.exitCode === 0 || existsSync(outsideFile)) {
    throw new Error(`outside write was not denied: ${JSON.stringify(outside)}`)
  }

  process.stdout.write(
    `windows-acl-console-smoke: passed with PowerShell 5.1 `
    + `(output=${output.stdout}, inside=${inside.stdout}, outsideExit=${outside.exitCode})\n`,
  )
} finally {
  rmSync(smokeRoot, { recursive: true, force: true })
}
