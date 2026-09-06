# Run the native acceptance suite as a newly created, genuinely non-admin user.
# This script is for a disposable Windows CI runner. It never installs network
# exemptions or changes MXC policy. Administrator rights provision/retire the
# test identity only; all assertions and sandbox launches use its normal token.
[CmdletBinding()]
param(
    [string] $Workspace = (Split-Path -Parent $PSScriptRoot),
    [ValidateRange(30, 3600)] [int] $TimeoutSeconds = 900
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:OS -ne 'Windows_NT') { throw 'This runner requires Windows.' }
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Provisioning the standard-user CI identity requires an elevated runner.'
}
$Workspace = (Resolve-Path -LiteralPath $Workspace).Path
$node = (Get-Command node.exe -ErrorAction Stop).Source
$vitest = Join-Path $Workspace 'node_modules\vitest\vitest.mjs'
if (-not (Test-Path -LiteralPath $vitest -PathType Leaf)) { throw 'Install repository dependencies before running native acceptance.' }
$nonce = [Guid]::NewGuid().ToString('N')
$userName = 'mxc-' + $nonce.Substring(0, 12)
$taskRoot = Join-Path ([IO.Path]::GetTempPath()) ('vibestudio-standard-user-' + $nonce)
New-Item -ItemType Directory -Path $taskRoot | Out-Null
$account = $null
$testProcess = $null
$checkoutAcl = $null
$checkoutGranted = $false
$processesRetired = $false
$exitCode = 1
$executionFailure = $null
$cleanupFailures = [Collections.Generic.List[string]]::new()
try {
    # Never expose the generated credential to command arguments, logs or disk.
    $secretBytes = [byte[]]::new(32)
    [Security.Cryptography.RandomNumberGenerator]::Fill($secretBytes)
    $password = ConvertTo-SecureString ('Aa1!' + [Convert]::ToBase64String($secretBytes)) -AsPlainText -Force
    [Array]::Clear($secretBytes, 0, $secretBytes.Length)
    $account = New-LocalUser -Name $userName -Password $password -AccountNeverExpires -PasswordNeverExpires -UserMayNotChangePassword
    $usersGroup = Get-LocalGroup -SID 'S-1-5-32-545'
    if (-not (Get-LocalGroupMember -Group $usersGroup | Where-Object { $_.SID.Value -eq $account.SID.Value })) {
        Add-LocalGroupMember -Group $usersGroup -Member $account
    }
    $credential = [Management.Automation.PSCredential]::new("$env:COMPUTERNAME\$userName", $password)

    # A normal developer owns their checkout. Grant this one ephemeral identity
    # access to this job's checkout, not to another user's home or system paths.
    # The original descriptor is restored after every account-owned process exits.
    $checkoutAcl = Get-Acl -LiteralPath $Workspace
    $workingAcl = Get-Acl -LiteralPath $Workspace
    $workingAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        $account.SID, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    $checkoutGranted = $true
    Set-Acl -LiteralPath $Workspace -AclObject $workingAcl
    $taskAcl = Get-Acl -LiteralPath $taskRoot
    $taskAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        $account.SID, 'ReadAndExecute', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    Set-Acl -LiteralPath $taskRoot -AclObject $taskAcl

    $payloadPath = Join-Path $taskRoot 'invocation.json'
    @{ workspace = $Workspace; node = $node; vitest = $vitest; sid = $account.SID.Value; path = $env:PATH } |
        ConvertTo-Json -Compress | Set-Content -LiteralPath $payloadPath -Encoding utf8
    $childScript = @'
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$inputData = Get-Content -LiteralPath '__PAYLOAD__' -Raw | ConvertFrom-Json
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if ($identity.User.Value -ne $inputData.sid) { throw 'Native tests are running under the wrong identity.' }
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -or
    @($identity.Groups | ForEach-Object { $_.Value }) -contains 'S-1-5-32-544') {
    throw 'Native tests require an account outside Administrators, not an administrator with a filtered token.'
}
$profileRoot = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
$localData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
$systemRoot = [Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)
if (-not $profileRoot -or -not $localData -or -not $systemRoot) { throw 'The standard-user profile was not loaded.' }
# Retain installed tool discovery, while preventing the elevated runner's home,
# temp paths, tokens, NODE_OPTIONS or MXC overrides leaking into this session.
foreach ($key in @([Environment]::GetEnvironmentVariables().Keys)) {
    if (-not ([string]$key).StartsWith('=')) { [Environment]::SetEnvironmentVariable($key, $null, 'Process') }
}
$env:PATH = $inputData.path
$env:SystemRoot = $systemRoot
$env:WINDIR = $systemRoot
$env:ComSpec = Join-Path $systemRoot 'System32\cmd.exe'
$env:PATHEXT = '.COM;.EXE;.BAT;.CMD'
$env:USERPROFILE = $profileRoot
$env:HOME = $profileRoot
$env:LOCALAPPDATA = $localData
$env:APPDATA = Join-Path $profileRoot 'AppData\Roaming'
$env:TEMP = Join-Path $localData 'Temp'
$env:TMP = $env:TEMP
$env:CI = 'true'
New-Item -ItemType Directory -Force -Path $env:TEMP | Out-Null
Set-Location -LiteralPath $inputData.workspace
Write-Output "Native acceptance identity: $($identity.Name), SID $($identity.User.Value), Administrators membership: absent"
& $inputData.node $inputData.vitest run --config packages/process-adapter/vitest.native.config.ts
exit $LASTEXITCODE
'@
    $childScript = $childScript.Replace('__PAYLOAD__', $payloadPath.Replace("'", "''"))
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($childScript))
    $stdout = Join-Path $taskRoot 'stdout.log'
    $stderr = Join-Path $taskRoot 'stderr.log'
    $testProcess = Start-Process -FilePath (Join-Path $PSHOME 'pwsh.exe') `
        -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', $encoded) `
        -Credential $credential -LoadUserProfile -WorkingDirectory $Workspace `
        -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    if (-not $testProcess.WaitForExit($TimeoutSeconds * 1000)) { throw "Standard-user native tests exceeded $TimeoutSeconds seconds." }
    $testProcess.WaitForExit()
    $exitCode = $testProcess.ExitCode
} catch {
    $executionFailure = $_
} finally {
    # Account ownership scopes cleanup. Never kill a process merely by image
    # name; unrelated runner/service processes must remain untouched.
    if ($null -ne $account) {
        try {
            Disable-LocalUser -SID $account.SID
            for ($attempt = 0; $attempt -lt 5; $attempt++) {
                $owned = @(Get-CimInstance Win32_Process | Where-Object {
                    $owner = Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid -ErrorAction SilentlyContinue
                    $null -ne $owner -and $owner.Sid -eq $account.SID.Value
                })
                if ($owned.Count -eq 0) { break }
                foreach ($process in $owned) {
                    $result = Invoke-CimMethod -InputObject $process -MethodName Terminate
                    if ($result.ReturnValue -ne 0) { throw "Failed to retire owned process $($process.ProcessId): $($result.ReturnValue)" }
                }
                Start-Sleep -Milliseconds 200
            }
            $remaining = @(Get-CimInstance Win32_Process | Where-Object {
                $owner = Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid -ErrorAction SilentlyContinue
                $null -ne $owner -and $owner.Sid -eq $account.SID.Value
            })
            if ($remaining.Count -ne 0) { throw 'Standard-user processes did not retire.' }
            $processesRetired = $true
        } catch { $cleanupFailures.Add("process retirement: $_") }
        if ($processesRetired -and $checkoutGranted) {
            try { Set-Acl -LiteralPath $Workspace -AclObject $checkoutAcl }
            catch { $cleanupFailures.Add("checkout ACL restoration: $_") }
        }
        if ($processesRetired) {
            try {
                Get-CimInstance Win32_UserProfile -Filter "SID='$($account.SID.Value)'" | Remove-CimInstance
            } catch { $cleanupFailures.Add("profile removal: $_") }
            try { Remove-LocalUser -SID $account.SID }
            catch { $cleanupFailures.Add("account removal: $_") }
        }
    }
    foreach ($file in @('stdout.log', 'stderr.log')) {
        $log = Join-Path $taskRoot $file
        if (Test-Path -LiteralPath $log) { Get-Content -LiteralPath $log | Write-Output }
    }
    if ($cleanupFailures.Count -eq 0) { Remove-Item -LiteralPath $taskRoot -Recurse -Force }
    else { Write-Warning ("Standard-user cleanup failed; logs retained at ${taskRoot}: " + ($cleanupFailures -join '; ')) }
}
$failures = [Collections.Generic.List[Exception]]::new()
if ($null -ne $executionFailure) { $failures.Add($executionFailure.Exception) }
elseif ($exitCode -ne 0) { $failures.Add([InvalidOperationException]::new("Native acceptance exited $exitCode.")) }
foreach ($failure in $cleanupFailures) { $failures.Add([InvalidOperationException]::new($failure)) }
if ($failures.Count -ne 0) { throw [AggregateException]::new('Standard-user native acceptance failed.', $failures) }
