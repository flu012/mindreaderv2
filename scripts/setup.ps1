# MindReader Setup Wizard (PowerShell)
# Guides first-time users through configuration of the MindReader monorepo.
# Works on Windows PowerShell 5.1+ and PowerShell Core 7+.

$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
$RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not $RepoRoot) { $RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path }
$EnvFile = Join-Path $RepoRoot ".env"
$DockerComposeFile = Join-Path $RepoRoot "packages\mindgraph\docker\docker-compose.yml"
$PythonDir = Join-Path $RepoRoot "packages\mindgraph\python"
$VenvDir = Join-Path $PythonDir ".venv"
$MgCli = Join-Path $PythonDir "mg_cli.py"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
function Write-Info($msg)    { Write-Host "[INFO]  $msg" -ForegroundColor Cyan }
function Write-Success($msg) { Write-Host "[OK]    $msg" -ForegroundColor Green }
function Write-Warn($msg)    { Write-Host "[WARN]  $msg" -ForegroundColor Yellow }
function Write-Err($msg)     { Write-Host "[ERROR] $msg" -ForegroundColor Red }

function Ask($prompt, $default) {
    if ($default) {
        $reply = Read-Host "$prompt [$default]"
        if ([string]::IsNullOrWhiteSpace($reply)) { return $default }
        return $reply
    } else {
        return Read-Host $prompt
    }
}

function Ask-YN($prompt, $default = "Y") {
    if ($default -eq "Y") { $options = "Y/n" } else { $options = "y/N" }
    $reply = Read-Host "$prompt [$options]"
    if ([string]::IsNullOrWhiteSpace($reply)) { $reply = $default }
    return ($reply.ToUpper() -eq "Y")
}

function Ask-Secret($prompt) {
    $secure = Read-Host $prompt -AsSecureString
    $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr) }
    finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

function Write-Separator { Write-Host ("-" * 50) -ForegroundColor Cyan }

function Find-RealPython {
    # Returns the path to a real Python executable, skipping Windows Store stubs.
    foreach ($name in @("python3", "python")) {
        $cmd = Get-Command $name -ErrorAction SilentlyContinue
        if (-not $cmd) { continue }
        if ($cmd.Source -match 'WindowsApps') { continue }
        try {
            $out = & $cmd.Source --version 2>&1 | Out-String
            if ($out -match 'Python \d+\.\d+') { return $cmd.Source }
        } catch { continue }
    }
    return $null
}

# ---------------------------------------------------------------------------
# Banner
# ---------------------------------------------------------------------------
function Print-Banner {
    Write-Host ""
    Write-Host @"
  __  __ _           _ ____                _
 |  \/  (_)_ __   __| |  _ \ ___  __ _  __| | ___ _ __
 | |\/| | | '_ \ / _` | |_) / _ \/ _` |/ _` |/ _ \ '__|
 | |  | | | | | | (_| |  _ <  __/ (_| | (_| |  __/ |
 |_|  |_|_|_| |_|\__,_|_| \_\___|\__,_|\__,_|\___|_|

          Interactive Setup Wizard  v1.0
"@ -ForegroundColor Cyan
    Write-Separator
}

# ---------------------------------------------------------------------------
# Detect existing config
# ---------------------------------------------------------------------------
$script:ExistingEnv = @{}

function Handle-ExistingEnv {
    if (-not (Test-Path $EnvFile)) { return }

    Write-Warn "An existing .env file was detected at: $EnvFile"
    Write-Host ""
    Write-Host "  1) Reconfigure  - start over and overwrite .env"
    Write-Host "  2) Update       - keep existing values as defaults"
    Write-Host "  3) Skip         - exit without changes"
    Write-Host ""
    $choice = Ask "Choose an option" "2"

    switch ($choice) {
        "1" {
            Write-Info "Starting fresh configuration."
            Remove-Item $EnvFile -Force
        }
        "2" {
            Write-Info "Existing values will be used as defaults where applicable."
            foreach ($line in Get-Content $EnvFile) {
                if ($line -match '^\s*([A-Z_]+)\s*=\s*(.*)$') {
                    $script:ExistingEnv[$Matches[1]] = $Matches[2]
                }
            }
        }
        "3" {
            Write-Info "Exiting without changes."
            exit 0
        }
        default {
            Write-Warn "Invalid choice. Defaulting to update mode."
            foreach ($line in Get-Content $EnvFile) {
                if ($line -match '^\s*([A-Z_]+)\s*=\s*(.*)$') {
                    $script:ExistingEnv[$Matches[1]] = $Matches[2]
                }
            }
        }
    }
}

function Get-Default($key, $fallback) {
    if ($script:ExistingEnv.ContainsKey($key) -and $script:ExistingEnv[$key]) {
        return $script:ExistingEnv[$key]
    }
    return $fallback
}

# ---------------------------------------------------------------------------
# Step 1: Components
# ---------------------------------------------------------------------------
$script:IncludeOpenClaw = $false
$script:OpenClawExtPath = ""

function Step-Components {
    Write-Separator
    Write-Host "Step 1: Component Selection" -ForegroundColor White
    Write-Separator
    Write-Host ""
    Write-Host "The following components are always included:"
    Write-Host "  [+] MindGraph       - Python knowledge-graph core" -ForegroundColor Green
    Write-Host "  [+] MindReader UI   - Express server + React interface" -ForegroundColor Green
    Write-Host ""

    if (Ask-YN "Include OpenClaw Plugin? (optional integration for OpenClaw agents)" "N") {
        $script:IncludeOpenClaw = $true
        Write-Host ""

        $defaultExtPath = ""
        $openclawDir = Join-Path $env:USERPROFILE ".openclaw\extensions"
        if (Test-Path $openclawDir) { $defaultExtPath = $openclawDir }

        Write-Info "OpenClaw plugin selected."
        Write-Host "  The plugin files will be copied into your OpenClaw extensions directory."
        Write-Host ""
        $script:OpenClawExtPath = Ask "Path to your OpenClaw extensions directory" $defaultExtPath

        if ($script:OpenClawExtPath -and -not (Test-Path $script:OpenClawExtPath)) {
            Write-Warn "Directory does not exist: $($script:OpenClawExtPath)"
            if (Ask-YN "Create it?" "Y") {
                New-Item -ItemType Directory -Path $script:OpenClawExtPath -Force | Out-Null
                Write-Success "Created $($script:OpenClawExtPath)"
            }
        }
    }
    Write-Host ""
}

# ---------------------------------------------------------------------------
# Step 2: Neo4j
# ---------------------------------------------------------------------------
$script:Neo4jUri = ""
$script:Neo4jUser = ""
$script:Neo4jPassword = ""
$script:Neo4jManaged = $false

function Step-Neo4j {
    Write-Separator
    Write-Host "Step 2: Neo4j Database" -ForegroundColor White
    Write-Separator
    Write-Host ""

    $script:Neo4jUri = Get-Default "NEO4J_URI" "bolt://localhost:7687"
    $script:Neo4jUser = Get-Default "NEO4J_USER" "neo4j"
    $script:Neo4jPassword = Get-Default "NEO4J_PASSWORD" "neo4j"

    if (Ask-YN "Do you have an existing Neo4j instance to connect to?" "N") {
        Write-Info "Using existing Neo4j instance."
        $script:Neo4jUri = Ask "Neo4j URI" $script:Neo4jUri
        $script:Neo4jUser = Ask "Neo4j username" $script:Neo4jUser
        $script:Neo4jPassword = Ask-Secret "Neo4j password"
    } else {
        $script:Neo4jManaged = $true
        Write-Info "MindReader will start Neo4j via Docker."
        Write-Host ""

        $docker = Get-Command docker -ErrorAction SilentlyContinue
        if (-not $docker) {
            Write-Err "Docker is not installed or not in PATH."
            Write-Err "Please install Docker Desktop and re-run setup, or provide an existing Neo4j URI."
            exit 1
        }

        try { docker info 2>$null | Out-Null } catch {
            Write-Err "Docker daemon is not running. Please start Docker Desktop and re-run setup."
            exit 1
        }
        Write-Success "Docker is available."

        Write-Info "Starting Neo4j container..."
        docker compose -f $DockerComposeFile up -d
        if ($LASTEXITCODE -eq 0) {
            Write-Success "Neo4j container started."
            Write-Info "Waiting 10 seconds for Neo4j to become ready..."
            Start-Sleep -Seconds 10
        } else {
            Write-Err "Failed to start Neo4j container."
            exit 1
        }
    }
    Write-Host ""
}

# ---------------------------------------------------------------------------
# Step 3: LLM Provider
# ---------------------------------------------------------------------------
$script:LlmProvider = ""
$script:LlmBaseUrl = ""
$script:LlmModel = ""
$script:LlmApiKey = ""
$script:LlmEvolveModel = ""
$script:EmbedderProvider = ""
$script:EmbedderBaseUrl = ""
$script:EmbedderModel = ""
$script:EmbedderApiKey = ""

function Step-LLM {
    Write-Separator
    Write-Host "Step 3: LLM Provider" -ForegroundColor White
    Write-Separator
    Write-Host ""
    Write-Host "Select your LLM provider:"
    Write-Host "  1) OpenAI    - gpt-4o-mini (default)"
    Write-Host "  2) Anthropic - claude-sonnet-4-6 (native API support)"
    Write-Host "  3) DashScope - qwen3.5-flash (Alibaba Cloud)"
    Write-Host ""

    $llmChoice = Ask "Choice" "1"

    switch ($llmChoice) {
        "1" {
            $script:LlmProvider = "openai"
            $script:LlmBaseUrl = "https://api.openai.com/v1"
            $defaultModel = "gpt-4o-mini"
        }
        "2" {
            $script:LlmProvider = "anthropic"
            $script:LlmBaseUrl = "https://api.anthropic.com/v1"
            $defaultModel = "claude-sonnet-4-6"
        }
        "3" {
            $script:LlmProvider = "dashscope"
            $script:LlmBaseUrl = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
            $defaultModel = "qwen3.5-flash"
        }
        default {
            Write-Warn "Invalid choice. Defaulting to OpenAI."
            $script:LlmProvider = "openai"
            $script:LlmBaseUrl = "https://api.openai.com/v1"
            $defaultModel = "gpt-4o-mini"
        }
    }

    Write-Info "Default model for $($script:LlmProvider): $defaultModel"
    $script:LlmModel = Ask "LLM model (press Enter to keep default)" (Get-Default "LLM_MODEL" $defaultModel)
    $script:LlmApiKey = Ask-Secret "API key for $($script:LlmProvider)"

    Write-Host ""
    Write-Info "Node Evolve uses a separate model with web search capability."
    Write-Info "Leave blank to use the same model as LLM_MODEL ($($script:LlmModel))."
    $script:LlmEvolveModel = Ask "Evolve model (blank = same as LLM)" ""
    Write-Host ""

    # Embedder
    Write-Separator
    Write-Host "Step 3b: Embedder Provider" -ForegroundColor White
    Write-Separator
    Write-Host ""
    Write-Host "Select your embedder provider:"
    Write-Host "  1) OpenAI    - text-embedding-3-small"
    Write-Host "  2) DashScope - text-embedding-v4"
    Write-Host "  3) Same as LLM provider"
    Write-Host ""

    $embChoice = Ask "Choice" "3"

    switch ($embChoice) {
        "1" {
            $script:EmbedderProvider = "openai"
            $script:EmbedderBaseUrl = "https://api.openai.com/v1"
            $embDefaultModel = "text-embedding-3-small"
            $script:EmbedderApiKey = Ask-Secret "API key for OpenAI embedder (Enter to reuse LLM key)"
            if ([string]::IsNullOrWhiteSpace($script:EmbedderApiKey)) { $script:EmbedderApiKey = $script:LlmApiKey }
        }
        "2" {
            $script:EmbedderProvider = "dashscope"
            $script:EmbedderBaseUrl = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
            $embDefaultModel = "text-embedding-v4"
            $script:EmbedderApiKey = Ask-Secret "API key for DashScope embedder (Enter to reuse LLM key)"
            if ([string]::IsNullOrWhiteSpace($script:EmbedderApiKey)) { $script:EmbedderApiKey = $script:LlmApiKey }
        }
        default {
            if ($script:LlmProvider -eq "anthropic") {
                Write-Warn "Anthropic does not provide an embeddings API."
                Write-Info "Defaulting to OpenAI for embeddings. You'll need an OpenAI API key."
                $script:EmbedderProvider = "openai"
                $script:EmbedderBaseUrl = "https://api.openai.com/v1"
                $embDefaultModel = "text-embedding-3-small"
                $script:EmbedderApiKey = Ask-Secret "API key for OpenAI embedder"
            } else {
                $script:EmbedderProvider = $script:LlmProvider
                $script:EmbedderBaseUrl = $script:LlmBaseUrl
                $script:EmbedderApiKey = $script:LlmApiKey
                switch ($script:EmbedderProvider) {
                    "openai"    { $embDefaultModel = "text-embedding-3-small" }
                    "dashscope" { $embDefaultModel = "text-embedding-v4" }
                    default     { $embDefaultModel = "text-embedding-3-small" }
                }
                Write-Info "Using same provider as LLM: $($script:EmbedderProvider)"
            }
        }
    }

    $script:EmbedderModel = Ask "Embedder model" (Get-Default "EMBEDDER_MODEL" $embDefaultModel)
    Write-Host ""
}

# ---------------------------------------------------------------------------
# Step 4: Verify & Install
# ---------------------------------------------------------------------------
function Verify-Neo4j {
    Write-Info "Testing Neo4j connection at $($script:Neo4jUri)..."

    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($node) {
        $neo4jMod = Join-Path $RepoRoot "node_modules\neo4j-driver"
        if (Test-Path $neo4jMod) {
            $testScript = @"
import neo4j from 'neo4j-driver';
const d = neo4j.driver('$($script:Neo4jUri)', neo4j.auth.basic('$($script:Neo4jUser)', '$($script:Neo4jPassword)'));
d.verifyConnectivity().then(() => { console.log('OK'); process.exit(0); }).catch(() => process.exit(1));
"@
            $result = $testScript | node --input-type=module 2>$null
            if ($LASTEXITCODE -eq 0) {
                Write-Success "Neo4j connection verified."
                return $true
            }
        }
    }
    return $false
}

function Verify-LLM {
    Write-Info "Testing LLM API ($($script:LlmProvider) / $($script:LlmModel))..."

    $pyPath = Find-RealPython
    if (-not $pyPath) {
        Write-Warn "Python not found - skipping LLM verification."
        return $true
    }

    $env:LLM_API_KEY = $script:LlmApiKey
    $env:LLM_MODEL = $script:LlmModel
    $env:LLM_BASE_URL = $script:LlmBaseUrl

    if ($script:LlmProvider -eq "anthropic") {
        $testCode = @"
import os
try:
    import anthropic
except ImportError:
    import subprocess, sys
    subprocess.check_call([sys.executable, '-m', 'pip', 'install', '-q', 'anthropic'])
    import anthropic
c = anthropic.Anthropic(api_key=os.environ['LLM_API_KEY'])
r = c.messages.create(model=os.environ['LLM_MODEL'], messages=[{'role':'user','content':'Hi'}], max_tokens=5)
print('OK:', r.content[0].text)
"@
    } else {
        $testCode = @"
import os
try:
    from openai import OpenAI
except ImportError:
    import subprocess, sys
    subprocess.check_call([sys.executable, '-m', 'pip', 'install', '-q', 'openai'])
    from openai import OpenAI
c = OpenAI(api_key=os.environ['LLM_API_KEY'], base_url=os.environ['LLM_BASE_URL'])
r = c.chat.completions.create(model=os.environ['LLM_MODEL'], messages=[{'role':'user','content':'Hi'}], max_tokens=5)
print('OK:', r.choices[0].message.content)
"@
    }

    $result = $testCode | & $pyPath 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Success "LLM API verified: $result"
        return $true
    }
    return $false
}

function Install-PythonVenv {
    Write-Info "Setting up Python virtual environment..."

    $py = Find-RealPython
    if (-not $py) {
        Write-Warn "Python not found - skipping venv setup."
        return
    }

    if (-not (Test-Path $VenvDir)) {
        & $py -m venv $VenvDir
    }

    $pip = Join-Path $VenvDir "Scripts\pip.exe"
    if (-not (Test-Path $pip)) { $pip = Join-Path $VenvDir "Scripts\pip" }

    & $pip install --quiet --upgrade pip
    & $pip install --quiet -r (Join-Path $PythonDir "requirements.txt")
    Write-Success "Python venv ready at $VenvDir"
}

function Install-NPM {
    Write-Info "Running npm install..."
    Push-Location $RepoRoot
    try { npm install --silent } finally { Pop-Location }
    Write-Success "npm dependencies installed."
}

function Build-UI {
    Write-Info "Building React UI..."
    Push-Location $RepoRoot
    try { npm run build } finally { Pop-Location }
    Write-Success "UI build complete."
}

function Install-OpenClawPlugin {
    Write-Info "Installing OpenClaw plugin..."
    $pluginSrc = Join-Path $RepoRoot "packages\openclaw-plugin"
    $pluginDest = Join-Path $script:OpenClawExtPath "mindreader"

    if (Test-Path $pluginDest) {
        Write-Warn "Extension directory already exists: $pluginDest"
        if (Ask-YN "Replace it?" "Y") {
            Remove-Item $pluginDest -Recurse -Force
        } else {
            Write-Warn "Skipping OpenClaw plugin installation."
            return
        }
    }

    New-Item -ItemType Directory -Path $pluginDest -Force | Out-Null
    Copy-Item (Join-Path $pluginSrc "index.js") $pluginDest
    Copy-Item (Join-Path $pluginSrc "package.json") $pluginDest
    Copy-Item (Join-Path $pluginSrc "openclaw.plugin.json") $pluginDest

    # Create junction (Windows equivalent of symlink) for node_modules
    $nodeModulesSrc = Join-Path $RepoRoot "node_modules"
    $nodeModulesDest = Join-Path $pluginDest "node_modules"
    if (Test-Path $nodeModulesDest) { Remove-Item $nodeModulesDest -Force -Recurse }
    cmd /c mklink /J "$nodeModulesDest" "$nodeModulesSrc" 2>$null
    if ($LASTEXITCODE -ne 0) {
        # Fallback: copy instead of junction
        Write-Warn "Could not create junction. Copying node_modules instead (this may take a moment)."
        Copy-Item $nodeModulesSrc $nodeModulesDest -Recurse
    }

    Write-Success "Plugin installed to: $pluginDest"
    Write-Host ""
    Write-Host "  Next steps for OpenClaw:"
    Write-Host "    1. Ensure 'mindreader' is in your openclaw.json plugins.entries"
    Write-Host "    2. Set plugins.slots.memory to 'mindreader'"
    Write-Host "    3. Restart OpenClaw:  openclaw gateway restart"
    Write-Host ""
}

function Step-VerifyInstall {
    Write-Separator
    Write-Host "Step 4: Verify & Install" -ForegroundColor White
    Write-Separator
    Write-Host ""

    # Neo4j verification
    $neo4jAttempts = 0
    while ($true) {
        $neo4jAttempts++
        if (Verify-Neo4j) { break }

        Write-Err "Could not connect to Neo4j at $($script:Neo4jUri)."
        if ($neo4jAttempts -ge 3) {
            Write-Warn "Neo4j verification failed after $neo4jAttempts attempts."
            if (Ask-YN "Skip Neo4j verification and continue anyway?" "N") {
                Write-Warn "Skipping Neo4j verification."
                break
            } else {
                $script:Neo4jUri = Ask "Re-enter Neo4j URI" $script:Neo4jUri
                $script:Neo4jUser = Ask "Re-enter Neo4j username" $script:Neo4jUser
                $script:Neo4jPassword = Ask-Secret "Re-enter Neo4j password"
            }
        } else {
            if (Ask-YN "Retry Neo4j connection?" "Y") { continue }
            else { Write-Warn "Skipping Neo4j verification."; break }
        }
    }

    # LLM verification
    $llmAttempts = 0
    while ($true) {
        $llmAttempts++
        if (Verify-LLM) { break }

        Write-Err "LLM API test failed for provider '$($script:LlmProvider)'."
        if ($llmAttempts -ge 2) {
            if (Ask-YN "Skip LLM verification and continue anyway?" "N") {
                Write-Warn "Skipping LLM verification."
                break
            } else {
                $script:LlmApiKey = Ask-Secret "Re-enter API key for $($script:LlmProvider)"
            }
        } else {
            if (Ask-YN "Retry LLM API test?" "Y") { continue }
            else { Write-Warn "Skipping LLM verification."; break }
        }
    }

    # Install dependencies
    Install-PythonVenv
    Install-NPM
    Build-UI
    Init-Neo4jIndexes

    # OpenClaw plugin
    if ($script:IncludeOpenClaw -and $script:OpenClawExtPath) {
        Install-OpenClawPlugin
    }

    Write-Host ""
}

# ---------------------------------------------------------------------------
# Neo4j index initialization
# ---------------------------------------------------------------------------
function Init-Neo4jIndexes {
    Write-Info "Initialising Neo4j indexes..."
    $initScript = Join-Path $PythonDir "init_db.py"
    if (Test-Path $initScript) {
        $pyPath = Find-RealPython
        if ($pyPath) {
            $venvPy = Join-Path $VenvDir "Scripts\python.exe"
            $usePy = if (Test-Path $venvPy) { $venvPy } else { $pyPath }
            try {
                & $usePy $initScript 2>$null
                Write-Success "Neo4j indexes initialised."
            } catch {
                Write-Warn "Index init script failed - you may need to run it manually."
            }
        }
    } else {
        Write-Warn "No init_db.py found - skipping index initialisation."
    }
}

# ---------------------------------------------------------------------------
# CLI Alias (optional)
# ---------------------------------------------------------------------------
function Step-Alias {
    Write-Separator
    Write-Host "CLI Alias (optional)" -ForegroundColor White
    Write-Separator
    Write-Host ""

    $profilePath = $PROFILE.CurrentUserAllHosts
    $pyPath = Find-RealPython
    if (-not $pyPath) { $pyPath = "python" }
    $aliasLine = "function mg { & `"$pyPath`" `"$MgCli`" @args }"

    if (Ask-YN "Add 'mg' command to your PowerShell profile ($profilePath)?" "Y") {
        # Create profile if it doesn't exist
        $profileDir = Split-Path -Parent $profilePath
        if (-not (Test-Path $profileDir)) {
            New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
        }
        if (-not (Test-Path $profilePath)) {
            New-Item -ItemType File -Path $profilePath -Force | Out-Null
        }

        $existing = Get-Content $profilePath -Raw -ErrorAction SilentlyContinue
        if ($existing -and $existing.Contains("function mg")) {
            Write-Info "mg function already present in profile - skipping."
        } else {
            Add-Content -Path $profilePath -Value "`n# MindReader CLI alias`n$aliasLine"
            Write-Success "Alias added. Run: . `$PROFILE  (or open a new terminal)"
        }
    } else {
        Write-Info "Skipping alias. You can add it manually to your PowerShell profile:"
        Write-Host "  $aliasLine"
    }
    Write-Host ""
}

# ---------------------------------------------------------------------------
# Write .env
# ---------------------------------------------------------------------------
function Write-EnvFile {
    Write-Separator
    Write-Host "Writing .env" -ForegroundColor White
    Write-Separator
    Write-Host ""

    $uiPort = Get-Default "UI_PORT" "18900"
    $timestamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

    $content = @"
# MindReader Configuration
# Generated by setup.ps1 on $timestamp

# -- UI -----------------------------------------------------------------------
UI_PORT=$uiPort

# -- Neo4j --------------------------------------------------------------------
NEO4J_URI=$($script:Neo4jUri)
NEO4J_USER=$($script:Neo4jUser)
NEO4J_PASSWORD=$($script:Neo4jPassword)

# -- LLM Provider -------------------------------------------------------------
LLM_PROVIDER=$($script:LlmProvider)
LLM_BASE_URL=$($script:LlmBaseUrl)
LLM_MODEL=$($script:LlmModel)
LLM_API_KEY=$($script:LlmApiKey)
LLM_EVOLVE_MODEL=$($script:LlmEvolveModel)

# -- Embedder -----------------------------------------------------------------
EMBEDDER_PROVIDER=$($script:EmbedderProvider)
EMBEDDER_BASE_URL=$($script:EmbedderBaseUrl)
EMBEDDER_MODEL=$($script:EmbedderModel)
EMBEDDER_API_KEY=$($script:EmbedderApiKey)
"@

    if ($script:IncludeOpenClaw) {
        $content += @"

# -- OpenClaw Plugin ----------------------------------------------------------
OPENCLAW_EXTENSIONS_PATH=$($script:OpenClawExtPath)
"@
    }

    Set-Content -Path $EnvFile -Value $content -Encoding UTF8
    Write-Success ".env written to $EnvFile"
    Write-Host ""
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
function Print-Summary {
    Write-Separator
    Write-Host "Setup Complete!" -ForegroundColor Green
    Write-Separator
    Write-Host ""
    Write-Host "Configuration Summary:" -ForegroundColor White
    Write-Host "  Neo4j URI      : $($script:Neo4jUri)"
    Write-Host "  Neo4j User     : $($script:Neo4jUser)"
    Write-Host "  LLM Provider   : $($script:LlmProvider) ($($script:LlmModel))"
    Write-Host "  Embedder       : $($script:EmbedderProvider) ($($script:EmbedderModel))"
    $oc = if ($script:IncludeOpenClaw) { "Enabled - $($script:OpenClawExtPath)" } else { "Not included" }
    Write-Host "  OpenClaw       : $oc"
    Write-Host "  UI Port        : $(Get-Default 'UI_PORT' '18900')"
    Write-Host ""
    Write-Host "To start MindReader:" -ForegroundColor White
    Write-Host "  npm run dev            - development mode (hot reload)" -ForegroundColor Cyan
    Write-Host "  npm start              - production mode" -ForegroundColor Cyan
    Write-Host ""
    if ($script:Neo4jManaged) {
        Write-Host "To manage Neo4j:" -ForegroundColor White
        Write-Host "  docker compose -f $DockerComposeFile up -d     - start" -ForegroundColor Cyan
        Write-Host "  docker compose -f $DockerComposeFile down      - stop" -ForegroundColor Cyan
        Write-Host ""
    }
    Write-Host "MindGraph CLI:" -ForegroundColor White
    Write-Host "  python $MgCli --help" -ForegroundColor Cyan
    Write-Host ""
    Write-Separator
}

# ---------------------------------------------------------------------------
# Prerequisite check
# ---------------------------------------------------------------------------
function Check-Prerequisites {
    Write-Separator
    Write-Host "Checking Prerequisites" -ForegroundColor White
    Write-Separator
    Write-Host ""

    $allOk = $true

    # Node.js
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($node) {
        $nodeVer = (node -v) -replace '^v', ''
        $nodeMajor = [int]($nodeVer.Split('.')[0])
        if ($nodeMajor -ge 18) {
            Write-Success "Node.js $nodeVer"
        } else {
            Write-Err "Node.js $nodeVer - version 18+ required"
            Write-Host "  Install: https://nodejs.org/en/download"
            Write-Host "  Or via winget: winget install OpenJS.NodeJS.LTS"
            $allOk = $false
        }
    } else {
        Write-Err "Node.js - not found"
        Write-Host "  Install: https://nodejs.org/en/download"
        Write-Host "  Or via winget: winget install OpenJS.NodeJS.LTS"
        Write-Host "  Or via choco:  choco install nodejs-lts"
        $allOk = $false
    }

    # npm
    $npm = Get-Command npm -ErrorAction SilentlyContinue
    if ($npm) {
        Write-Success "npm $(npm -v)"
    } else {
        Write-Err "npm - not found (should be installed with Node.js)"
        $allOk = $false
    }

    # Python — Windows has "python" app execution aliases that redirect to
    # the Microsoft Store instead of running Python. We must detect and skip those.
    $pyFound = $false
    foreach ($pyName in @("python3", "python")) {
        $pyCmd = Get-Command $pyName -ErrorAction SilentlyContinue
        if (-not $pyCmd) { continue }

        # Skip Windows Store stub aliases (WindowsApps path)
        if ($pyCmd.Source -match 'WindowsApps') { continue }

        # Try running it — wrap in try/catch because Store stubs throw errors
        try {
            $pyVerStr = & $pyCmd.Source --version 2>&1 | Out-String
            if ($pyVerStr -match '(\d+)\.(\d+)') {
                $pyMajor = [int]$Matches[1]
                $pyMinor = [int]$Matches[2]
                if ($pyMajor -ge 3 -and $pyMinor -ge 11) {
                    Write-Success "Python $pyMajor.$pyMinor ($($pyCmd.Source))"
                    $pyFound = $true
                    break
                } else {
                    Write-Err "Python $pyMajor.$pyMinor - version 3.11+ required"
                    Write-Host "  Install: https://www.python.org/downloads/"
                    Write-Host "  Or via winget: winget install Python.Python.3.12"
                    Write-Host "  IMPORTANT: Check 'Add python.exe to PATH' during install"
                    $allOk = $false
                    $pyFound = $true
                    break
                }
            }
        } catch {
            # Store stub or broken install — skip and try next
            continue
        }
    }
    if (-not $pyFound) {
        Write-Err "Python - not found"
        Write-Host "  Install: https://www.python.org/downloads/"
        Write-Host "  Or via winget: winget install Python.Python.3.12"
        Write-Host "  Or via choco:  choco install python312"
        Write-Host "  IMPORTANT: Check 'Add python.exe to PATH' during install"
        Write-Host ""
        Write-Host "  TIP: If you just installed Python, close and reopen PowerShell." -ForegroundColor Yellow
        Write-Host "  TIP: Disable Windows Store aliases: Settings > Apps > Advanced app settings > App execution aliases" -ForegroundColor Yellow
        $allOk = $false
    }

    # Docker
    $docker = Get-Command docker -ErrorAction SilentlyContinue
    if ($docker) {
        $dockerVer = (docker --version) -replace 'Docker version\s*', '' -replace ',.*', ''
        try {
            docker info 2>$null | Out-Null
            if ($LASTEXITCODE -eq 0) {
                Write-Success "Docker $dockerVer (daemon running)"
            } else {
                Write-Warn "Docker $dockerVer (daemon NOT running)"
                Write-Host "  Start Docker Desktop from the Start menu or system tray"
                Write-Host "  You can skip Docker if you have an existing Neo4j instance."
            }
        } catch {
            Write-Warn "Docker $dockerVer (daemon NOT running)"
            Write-Host "  Start Docker Desktop from the Start menu or system tray"
        }
    } else {
        Write-Warn "Docker - not found"
        Write-Host "  Install: https://docs.docker.com/desktop/install/windows-install/"
        Write-Host "  Or via winget: winget install Docker.DockerDesktop"
        Write-Host "  You can skip Docker if you have an existing Neo4j 5.x instance."
    }

    # Git
    $git = Get-Command git -ErrorAction SilentlyContinue
    if ($git) {
        $gitVer = (git --version) -replace 'git version\s*', '' -replace '\.windows.*', ''
        Write-Success "git $gitVer"
    }

    Write-Host ""
    if (-not $allOk) {
        Write-Err "Some required prerequisites are missing (see above)."
        Write-Host ""
        if (-not (Ask-YN "Continue setup anyway?" "N")) {
            Write-Info "Please install the missing prerequisites and re-run: npm run setup"
            exit 1
        }
        Write-Host ""
    } else {
        Write-Success "All prerequisites satisfied!"
        Write-Host ""
    }
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
Print-Banner
Check-Prerequisites
Handle-ExistingEnv
Step-Components
Step-Neo4j
Step-LLM
Step-VerifyInstall
Write-EnvFile
Step-Alias
Print-Summary
