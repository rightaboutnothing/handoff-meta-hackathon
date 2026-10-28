$ErrorActionPreference = 'Stop'
$privacyRoot = Split-Path -Parent $PSScriptRoot
$privacyEnvironment = Join-Path $privacyRoot '.cache/privacy-python312'
$privacyPython = $env:HANDOFF_PYTHON312
if (-not $privacyPython) {
  $privacyPython = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'
}
if (-not (Test-Path -LiteralPath $privacyPython)) { throw 'Python 3.12 is required. Set HANDOFF_PYTHON312 to its executable.' }
$privacyVersion = & $privacyPython -c 'import sys; print(sys.version_info[:2] == (3,12))'
if ($privacyVersion -ne 'True') { throw 'The privacy comparison requires Python 3.12.' }
& $privacyPython -m venv $privacyEnvironment *> $null
if ($LASTEXITCODE -ne 0) { throw 'Local privacy environment creation failed.' }
$privacyExecutable = Join-Path $privacyEnvironment 'Scripts/python.exe'
& $privacyExecutable -m pip --isolated install --quiet --index-url https://pypi.org/simple -r (Join-Path $PSScriptRoot 'privacy-requirements.txt') *> $null
if ($LASTEXITCODE -ne 0) { throw 'Pinned privacy dependency installation failed.' }
& $privacyExecutable -m pip --isolated install --quiet --index-url https://pypi.org/simple https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl *> $null
if ($LASTEXITCODE -ne 0) { throw 'Pinned local spaCy model installation failed.' }
Write-Output 'Local Python 3.12 privacy environment ready. No inference or credential output.'
