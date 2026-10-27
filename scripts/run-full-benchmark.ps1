param(
    [switch]$OfflineMeta
)

$ErrorActionPreference = "Continue"
$repository = Split-Path -Parent $PSScriptRoot
$runDirectory = Join-Path $repository ".logs\benchmark-full-50-seed-20261027"
$supervisorLog = Join-Path $runDirectory "supervisor.log"
$stdoutLog = Join-Path $runDirectory "process-stdout.log"
$stderrLog = Join-Path $runDirectory "process-stderr.log"

New-Item -ItemType Directory -Force -Path $runDirectory | Out-Null

for ($attempt = 1; $attempt -le 10; $attempt += 1) {
    Add-Content -LiteralPath $supervisorLog -Value "[$([DateTime]::UtcNow.ToString('o'))] Starting or resuming benchmark process; supervisor attempt $attempt/10."
    Push-Location $repository
    try {
        $nodeArguments = @("scripts/run-full-benchmark.mjs")
        if ($OfflineMeta) {
            $nodeArguments += "--offline-meta"
        }
        & node @nodeArguments 1>> $stdoutLog 2>> $stderrLog
        $exitCode = $LASTEXITCODE
    }
    finally {
        Pop-Location
    }
    Add-Content -LiteralPath $supervisorLog -Value "[$([DateTime]::UtcNow.ToString('o'))] Benchmark process exited with code $exitCode."
    if ($exitCode -eq 0) {
        exit 0
    }
    $backoffSeconds = [Math]::Min(300, 30 * [Math]::Pow(2, $attempt - 1))
    Add-Content -LiteralPath $supervisorLog -Value "[$([DateTime]::UtcNow.ToString('o'))] Resuming after $backoffSeconds seconds."
    Start-Sleep -Seconds $backoffSeconds
}

Add-Content -LiteralPath $supervisorLog -Value "[$([DateTime]::UtcNow.ToString('o'))] Supervisor exhausted 10 process restarts."
exit 1
