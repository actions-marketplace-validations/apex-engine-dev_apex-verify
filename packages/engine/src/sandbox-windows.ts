import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A sandbox for Windows: the command runs in an AppContainer (the isolation Windows gives Store apps and browsers' renderers).
 * An AppContainer process, with no capabilities granted:
 *  - cannot reach the network at all (this includes localhost, which Windows blocks for AppContainers unless an
 *    administrator exempts the container: tests that start a local server fail here, and the test runner then falls
 *    back to running the project's own tests outside, as it does on macOS and Linux);
 *  - can write only where its SID was granted access (here: the scratch copy of the project and a temp folder inside it);
 *  - cannot read the user's profile (documents, ~/.ssh, other projects) because those ACLs do not name it.
 * It can read the Windows folders and Program Files (they carry an ACE for all application packages) and the folder of
 * the Node that runs the command (granted here, best effort). A project whose dependencies live outside the copy, a
 * linked node_modules for one, cannot be read, so its tests fail in the sandbox and run outside it: nothing is made worse.
 *
 * A PowerShell wrapper (embedded, written to the temp folder) creates the container profile once, grants the folders,
 * and starts the command with CreateProcess and a SECURITY_CAPABILITIES attribute. stdout and stderr are the wrapper's own
 * handles, so the output reaches the caller as it does without a sandbox. Windows PowerShell 5.1 and .NET Framework are
 * on every supported Windows, so nothing is installed.
 */
export const WIN_PREFIX = "appcontainer:";

const CSHARP = String.raw`
using System; using System.Runtime.InteropServices; using System.Text;
public static class ApexAC {
  [StructLayout(LayoutKind.Sequential)] struct SECURITY_CAPABILITIES { public IntPtr AppContainerSid; public IntPtr Capabilities; public uint CapabilityCount; public uint Reserved; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUPINFO { public int cb; public string lpReserved; public string lpDesktop; public string lpTitle; public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags; public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }
  [DllImport("userenv.dll", CharSet=CharSet.Unicode)] static extern int CreateAppContainerProfile(string name, string display, string desc, IntPtr caps, uint capCount, out IntPtr sid);
  [DllImport("userenv.dll", CharSet=CharSet.Unicode)] static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertSidToStringSid(IntPtr sid, out string s);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attr, IntPtr value, IntPtr size, IntPtr prev, IntPtr ret);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
  [DllImport("kernel32.dll")] static extern bool SetHandleInformation(IntPtr h, uint mask, uint flags);
  public static string Sid(string name) {
    IntPtr sid;
    int hr = CreateAppContainerProfile(name, name, "Apex verify test sandbox", IntPtr.Zero, 0, out sid);
    if (hr != 0) { hr = DeriveAppContainerSidFromAppContainerName(name, out sid); if (hr != 0) throw new Exception("AppContainer profile failed: 0x" + hr.ToString("X")); }
    string s; ConvertSidToStringSid(sid, out s); return s;
  }
  public static int Run(string name, string cmdline, string cwd, string envBlock) {
    IntPtr sid; if (DeriveAppContainerSidFromAppContainerName(name, out sid) != 0) throw new Exception("no AppContainer profile");
    SECURITY_CAPABILITIES sc = new SECURITY_CAPABILITIES(); sc.AppContainerSid = sid;
    IntPtr scPtr = Marshal.AllocHGlobal(Marshal.SizeOf(sc)); Marshal.StructureToPtr(sc, scPtr, false);
    IntPtr size = IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
    IntPtr list = Marshal.AllocHGlobal(size);
    if (!InitializeProcThreadAttributeList(list, 1, 0, ref size)) throw new Exception("InitializeProcThreadAttributeList " + Marshal.GetLastWin32Error());
    if (!UpdateProcThreadAttribute(list, 0, (IntPtr)0x00020009, scPtr, (IntPtr)Marshal.SizeOf(sc), IntPtr.Zero, IntPtr.Zero)) throw new Exception("UpdateProcThreadAttribute " + Marshal.GetLastWin32Error());
    STARTUPINFOEX si = new STARTUPINFOEX(); si.StartupInfo.cb = Marshal.SizeOf(si); si.lpAttributeList = list;
    IntPtr hin = GetStdHandle(-10), hout = GetStdHandle(-11), herr = GetStdHandle(-12);
    foreach (IntPtr h in new IntPtr[] { hin, hout, herr }) if (h != IntPtr.Zero && h != (IntPtr)(-1)) SetHandleInformation(h, 1, 1);
    si.StartupInfo.dwFlags = 0x100; si.StartupInfo.hStdInput = hin; si.StartupInfo.hStdOutput = hout; si.StartupInfo.hStdError = herr;
    IntPtr env = Marshal.StringToHGlobalUni(envBlock);
    PROCESS_INFORMATION pi;
    // EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW
    if (!CreateProcess(null, new StringBuilder(cmdline), IntPtr.Zero, IntPtr.Zero, true, 0x80000 | 0x400 | 0x08000000, env, cwd, ref si, out pi)) throw new Exception("CreateProcess failed: " + Marshal.GetLastWin32Error());
    WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
    uint code; GetExitCodeProcess(pi.hProcess, out code);
    return unchecked((int)code);
  }
}`;

/** The wrapper script. Arguments: -Spec <base64 JSON {name, writable, cmd, cwd, temp}>. Its exit code is the command's. */
export const WIN_WRAPPER = `param([string]$Spec)
$ErrorActionPreference = 'Stop'
$o = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Spec)) | ConvertFrom-Json
$src = @'
${CSHARP}
'@
# Compiled once per machine (the C# compiler costs seconds): later runs load the saved assembly.
try { if ($o.dll -and (Test-Path $o.dll)) { Add-Type -Path $o.dll } else { throw 'compile' } }
catch {
  try { if ($o.dll) { New-Item -ItemType Directory -Force -Path (Split-Path $o.dll) | Out-Null; Add-Type -TypeDefinition $src -OutputAssembly $o.dll -OutputType Library; Add-Type -Path $o.dll } else { throw 'inline' } }
  catch { if (-not ('ApexAC' -as [type])) { Add-Type -TypeDefinition $src } }
}
$sid = [ApexAC]::Sid($o.name)
foreach ($d in @($o.writable)) { if ($d) { & icacls.exe $d /grant ("*" + $sid + ":(OI)(CI)M") /C /Q | Out-Null } }
# Read access to Node's own folder, granted once: the grant walks every file in it, which is slow, so later runs only look.
foreach ($d in @($o.readable)) { if ($d) { $have = (& icacls.exe $d 2>$null) -join ' '; if ($have -notmatch [regex]::Escape($sid) -and $have -notmatch [regex]::Escape($o.name)) { & icacls.exe $d /grant ("*" + $sid + ":(OI)(CI)RX") /C /Q 2>$null | Out-Null } } }
if ($o.temp) { New-Item -ItemType Directory -Force -Path $o.temp | Out-Null }
$e = [Environment]::GetEnvironmentVariables()
if ($o.temp) { $e['TEMP'] = $o.temp; $e['TMP'] = $o.temp }
$block = (($e.GetEnumerator() | ForEach-Object { $_.Key + '=' + $_.Value }) -join [char]0) + [char]0 + [char]0
exit ([ApexAC]::Run($o.name, $o.cmd, $o.cwd, $block))
`;

// Quoted whenever cmd.exe could read a character as syntax (& | < > ^ % ( ) and spaces), not only for spaces.
const quote = (a: string) => (a === "" || /[\s"&|<>^%()!,;=]/.test(a) ? `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"` : a);

export function winSandboxSpec(o: { writable: string[] }): string {
  const writable = [...new Set(o.writable.map((p) => path.resolve(p)))];
  // The first writable folder is the working directory. Nothing outside the scratch copy is granted except read access to Node's own folder.
  return WIN_PREFIX + JSON.stringify({ writable, readable: [path.dirname(process.execPath)] });
}

let wrapperPath: string | null = null;
function wrapperFile(): string {
  if (wrapperPath && existsSync(wrapperPath)) return wrapperPath;
  const dir = path.join(os.tmpdir(), "apex-verify-win");
  mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `sandbox-${createHash("sha1").update(WIN_WRAPPER).digest("hex").slice(0, 8)}.ps1`);
  writeFileSync(f, WIN_WRAPPER);
  return (wrapperPath = f);
}

/** `file args` as a command inside the AppContainer wrapper. */
export function inWindowsSandbox(spec: string, file: string, args: string[]): { file: string; args: string[] } {
  const s = JSON.parse(spec.slice(WIN_PREFIX.length)) as { writable: string[]; readable: string[] };
  const shim = /^(?:npm|npx|yarn|pnpm)(?:\.cmd)?$/i.test(file);
  const cmd = shim ? `cmd.exe /d /s /c "${[file, ...args].map(quote).join(" ")}"` : [file, ...args].map(quote).join(" ");
  const workdir = s.writable[0]!;
  const payload = { name: "ApexVerifySandbox", writable: s.writable, readable: s.readable, cmd, cwd: workdir, temp: path.join(workdir, ".apex-tmp"), dll: path.join(os.tmpdir(), "apex-verify-win", `ApexAC-${createHash("sha1").update(CSHARP).digest("hex").slice(0, 8)}.dll`) };
  return { file: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", wrapperFile(), "-Spec", Buffer.from(JSON.stringify(payload), "utf8").toString("base64")] };
}
