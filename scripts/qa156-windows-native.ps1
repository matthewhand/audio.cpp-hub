# PR #156 native-Windows SSE validation: explicit approval required.
# MANUAL only, never CI. Runs a hash-verified prebuilt Go test binary.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$TestExecutable,
    [Parameter(Mandatory = $true)][string]$ExpectedSHA256,
    [Parameter(Mandatory = $true)][string]$RepositoryDirectory,
    [switch]$OwnerApproved
)

$ErrorActionPreference = 'Stop'
if (-not $OwnerApproved) {
    throw 'Native Windows execution requires separate owner approval (-OwnerApproved after approval).'
}
if ($ExpectedSHA256 -notmatch '^[A-Fa-f0-9]{64}$') {
    throw 'ExpectedSHA256 must be an exact 64-digit SHA-256 digest.'
}
$exe = (Resolve-Path -LiteralPath $TestExecutable -ErrorAction Stop).Path
$repo = (Resolve-Path -LiteralPath $RepositoryDirectory -ErrorAction Stop).Path
if ([IO.Path]::GetFileName($exe) -notlike 'audio156-*.test.exe') {
    throw 'Refusing non-test executable name. Expected audio156-*.test.exe.'
}
if (-not (Test-Path -LiteralPath (Join-Path $repo 'go.mod') -PathType Leaf)) {
    throw 'RepositoryDirectory must be a checkout containing go.mod.'
}
$actual = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash
if ($actual -ine $ExpectedSHA256) {
    throw 'Test executable SHA-256 mismatch; refused to execute.'
}
$drive = [IO.Path]::GetPathRoot($exe)
$disk = Get-CimInstance Win32_LogicalDisk | Where-Object { $_.DeviceID -eq $drive.TrimEnd('\') }
if ($null -eq $disk -or $disk.FreeSpace -lt 512MB) {
    throw 'Insufficient available disk or unreadable volume (requires 512 MiB free).'
}
$os = Get-CimInstance Win32_OperatingSystem
if ($os.FreePhysicalMemory -lt (1024 * 1024)) {
    throw 'Less than 1 GiB currently available memory; refused to execute.'
}

$oldEnv = @{}
foreach ($key in @('GOMAXPROCS', 'GOMEMLIMIT', 'GOPROXY', 'GOTOOLCHAIN', 'TMP', 'TEMP')) {
    $oldEnv[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
}
$work = Join-Path ([IO.Path]::GetTempPath()) ('audio156-native-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work -ErrorAction Stop | Out-Null
$stdout = Join-Path $work 'stdout.log'
$stderr = Join-Path $work 'stderr.log'
$proc = $null
try {
    $env:GOMAXPROCS = '2'
    $env:GOMEMLIMIT = '768MiB'
    $env:GOPROXY = 'off'
    $env:GOTOOLCHAIN = 'local'
    $env:TMP = $work
    $env:TEMP = $work
    # A compiled Go test executable uses -test.* flags.
    # The regex runs only W01-W06, including W05's named subtests.
    # PowerShell 5.1 Start-Process -PassThru yielded a null ExitCode
    # after a successful native test. Use a directly owned .NET Process
    # and fail closed unless the exact process returns a numeric zero.
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $exe
    $psi.WorkingDirectory = $repo
    $psi.Arguments = '-test.run=^TestSSEWinNativeW0[1-6] -test.count=1 -test.timeout=30s -test.v'
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $candidate = New-Object System.Diagnostics.Process
    $candidate.StartInfo = $psi
    if (-not $candidate.Start()) {
        throw 'Test-owned native executable could not start.'
    }
    $proc = $candidate
    # Concurrent read tasks prevent a redirected OS pipe from blocking.
    $outTask = $proc.StandardOutput.ReadToEndAsync()
    $errTask = $proc.StandardError.ReadToEndAsync()
    try {
        if (-not $proc.HasExited) { $proc.PriorityClass = 'BelowNormal' }
    } catch {
        Write-Warning 'Could not set BelowNormal process priority.'
    }
    if (-not $proc.WaitForExit(45000)) {
        # /T terminates test-owned descendants; target ONLY our spawned PID.
        & "$env:SystemRoot\System32\taskkill.exe" /PID $proc.Id /T /F | Out-Null
        throw 'External 45-second watchdog expired; terminated test-owned process tree.'
    }
    $proc.WaitForExit()
    [IO.File]::WriteAllText($stdout, $outTask.GetAwaiter().GetResult())
    [IO.File]::WriteAllText($stderr, $errTask.GetAwaiter().GetResult())
    $exitCode = $proc.ExitCode
    if ($null -eq $exitCode) {
        throw 'Test-owned native process completed without a readable exit code.'
    }
    Write-Output ('QA156_TEST_PROCESS_EXIT_CODE=' + $exitCode)
    if ($exitCode -ne 0) {
        throw ('Native synthetic tests failed with exit code ' + $exitCode)
    }
    Write-Output 'QA156_WINDOWS_NATIVE_W01_W06_PASS'
}
finally {
    if ($null -ne $proc) {
        $proc.Refresh()
        if (-not $proc.HasExited) {
            & "$env:SystemRoot\System32\taskkill.exe" /PID $proc.Id /T /F | Out-Null
        }
    }
    foreach ($entry in @(@('stdout', $stdout), @('stderr', $stderr))) {
        if (Test-Path -LiteralPath $entry[1]) {
            Write-Output ('--- ' + $entry[0] + ' (first 64 KiB) ---')
            $fs = [IO.File]::OpenRead($entry[1])
            try {
                $n = [Math]::Min($fs.Length, 65536)
                $b = New-Object byte[] ([int]$n)
                [void]$fs.Read($b, 0, [int]$n)
                Write-Output ([Text.Encoding]::UTF8.GetString($b))
                if ($fs.Length -gt $n) { Write-Warning 'Output truncated at 64 KiB.' }
            } finally { $fs.Dispose() }
        }
    }
    foreach ($key in $oldEnv.Keys) {
        [Environment]::SetEnvironmentVariable($key, $oldEnv[$key], 'Process')
    }
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
