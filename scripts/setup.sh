#!/usr/bin/env bash
# MindReader Setup Wizard
# Guides first-time users through configuration of the MindReader monorepo.

set -euo pipefail

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"
PROVIDERS_FILE="$REPO_ROOT/config/providers.json"
DOCKER_COMPOSE_FILE="$REPO_ROOT/packages/mindgraph/docker/docker-compose.yml"
PYTHON_DIR="$REPO_ROOT/packages/mindgraph/python"
VENV_DIR="$PYTHON_DIR/.venv"
MG_CLI="$PYTHON_DIR/mg_cli.py"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

info()    { echo -e "${CYAN}${BOLD}[INFO]${RESET}  $*"; }
success() { echo -e "${GREEN}${BOLD}[OK]${RESET}    $*"; }
warn()    { echo -e "${YELLOW}${BOLD}[WARN]${RESET}  $*"; }
error()   { echo -e "${RED}${BOLD}[ERROR]${RESET} $*"; }

ask() {
    # ask <prompt> [default]
    local prompt="$1"
    local default="${2:-}"
    local reply
    if [[ -n "$default" ]]; then
        read -r -p "$(echo -e "${BOLD}${prompt}${RESET} [${default}]: ")" reply
        echo "${reply:-$default}"
    else
        read -r -p "$(echo -e "${BOLD}${prompt}${RESET}: ")" reply
        echo "$reply"
    fi
}

ask_yn() {
    # ask_yn <prompt> [Y|N default]  → returns 0 for yes, 1 for no
    local prompt="$1"
    local default="${2:-Y}"
    local options
    if [[ "${default^^}" == "Y" ]]; then
        options="Y/n"
    else
        options="y/N"
    fi
    local reply
    read -r -p "$(echo -e "${BOLD}${prompt}${RESET} [${options}]: ")" reply
    reply="${reply:-$default}"
    [[ "${reply^^}" == "Y" ]]
}

ask_secret() {
    local prompt="$1"
    local default="${2:-}"
    local reply
    if [[ -n "$default" ]]; then
        local masked="${default:0:4}$(printf '%*s' $((${#default} - 4)) '' | tr ' ' '*')"
        read -r -s -p "$(echo -e "${BOLD}${prompt}${RESET} [${masked}]: ")" reply
    else
        read -r -s -p "$(echo -e "${BOLD}${prompt}${RESET}: ")" reply
    fi
    echo
    echo "${reply:-$default}"
}

separator() { echo -e "${CYAN}──────────────────────────────────────────────────${RESET}"; }

# ---------------------------------------------------------------------------
# Banner
# ---------------------------------------------------------------------------
print_banner() {
    echo
    echo -e "${CYAN}${BOLD}"
    cat <<'BANNER'
  __  __ _           _ ____                _
 |  \/  (_)_ __   __| |  _ \ ___  __ _  __| | ___ _ __
 | |\/| | | '_ \ / _` | |_) / _ \/ _` |/ _` |/ _ \ '__|
 | |  | | | | | | (_| |  _ <  __/ (_| | (_| |  __/ |
 |_|  |_|_|_| |_|\__,_|_| \_\___|\__,_|\__,_|\___|_|

          Interactive Setup Wizard  v1.0
BANNER
    echo -e "${RESET}"
    separator
}

# ---------------------------------------------------------------------------
# Prerequisite check
# ---------------------------------------------------------------------------
check_prerequisites() {
    separator
    echo -e "${BOLD}Checking Prerequisites${RESET}"
    separator
    echo

    local all_ok=true

    # Node.js
    if command -v node &>/dev/null; then
        local node_ver
        node_ver="$(node -v 2>/dev/null | sed 's/^v//')"
        local node_major="${node_ver%%.*}"
        if [[ "$node_major" -ge 18 ]]; then
            success "Node.js ${node_ver}"
        else
            error "Node.js ${node_ver} — version 18+ required"
            echo "  Install: https://nodejs.org/en/download"
            echo "  Or via nvm: nvm install 18"
            all_ok=false
        fi
    else
        error "Node.js — not found"
        echo "  Install: https://nodejs.org/en/download"
        echo "  macOS:   brew install node"
        echo "  Ubuntu:  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs"
        all_ok=false
    fi

    # npm (should come with Node but check separately)
    if command -v npm &>/dev/null; then
        success "npm $(npm -v 2>/dev/null)"
    else
        error "npm — not found (should be installed with Node.js)"
        all_ok=false
    fi

    # Python
    local py_cmd=""
    if command -v python3 &>/dev/null; then
        py_cmd="python3"
    elif command -v python &>/dev/null; then
        py_cmd="python"
    fi

    if [[ -n "$py_cmd" ]]; then
        local py_ver
        py_ver="$($py_cmd --version 2>&1 | grep -oP '\d+\.\d+')"
        local py_major="${py_ver%%.*}"
        local py_minor="${py_ver#*.}"
        if [[ "$py_major" -ge 3 ]] && [[ "$py_minor" -ge 11 ]]; then
            success "Python ${py_ver} ($py_cmd)"
        else
            error "Python ${py_ver} — version 3.11+ required"
            echo "  Install: https://www.python.org/downloads/"
            echo "  macOS:   brew install python@3.12"
            echo "  Ubuntu:  sudo apt install python3.12 python3.12-venv"
            all_ok=false
        fi
    else
        error "Python — not found"
        echo "  Install: https://www.python.org/downloads/"
        echo "  macOS:   brew install python@3.12"
        echo "  Ubuntu:  sudo apt install python3.12 python3.12-venv"
        all_ok=false
    fi

    # Docker
    if command -v docker &>/dev/null; then
        local docker_ver
        docker_ver="$(docker --version 2>/dev/null | grep -oP '\d+\.\d+\.\d+')"
        if docker info &>/dev/null 2>&1; then
            success "Docker ${docker_ver} (daemon running)"
        else
            warn "Docker ${docker_ver} (daemon NOT running)"
            echo "  Start Docker Desktop or: sudo systemctl start docker"
            echo "  You can skip Docker if you have an existing Neo4j instance."
        fi
    else
        warn "Docker — not found"
        echo "  Install: https://docs.docker.com/get-docker/"
        echo "  You can skip Docker if you have an existing Neo4j 5.x instance."
    fi

    # Git (nice to have)
    if command -v git &>/dev/null; then
        success "git $(git --version 2>/dev/null | grep -oP '\d+\.\d+\.\d+')"
    fi

    echo
    if [[ "$all_ok" == "false" ]]; then
        error "Some required prerequisites are missing (see above)."
        echo
        if ! ask_yn "Continue setup anyway?" "N"; then
            info "Please install the missing prerequisites and re-run: npm run setup"
            exit 1
        fi
        echo
    else
        success "All prerequisites satisfied!"
        echo
    fi
}

# ---------------------------------------------------------------------------
# Detect existing config
# ---------------------------------------------------------------------------
handle_existing_env() {
    if [[ ! -f "$ENV_FILE" ]]; then
        return 0  # no existing config, proceed normally
    fi

    warn "An existing .env file was detected at: $ENV_FILE"
    echo
    echo "  1) Reconfigure  — start over and overwrite .env"
    echo "  2) Update       — keep existing values as defaults"
    echo "  3) Skip         — exit without changes"
    echo
    local choice
    choice="$(ask "Choose an option" "2")"
    case "$choice" in
        1)
            info "Starting fresh configuration."
            rm -f "$ENV_FILE"
            ;;
        2)
            info "Existing values will be used as defaults where applicable."
            # shellcheck source=/dev/null
            source "$ENV_FILE" 2>/dev/null || true
            ;;
        3)
            info "Exiting without changes."
            exit 0
            ;;
        *)
            warn "Invalid choice. Defaulting to update mode."
            # shellcheck source=/dev/null
            source "$ENV_FILE" 2>/dev/null || true
            ;;
    esac
}

# ---------------------------------------------------------------------------
# Step 1: Components
# ---------------------------------------------------------------------------
step_components() {
    separator
    echo -e "${BOLD}Step 1: Component Selection${RESET}"
    separator
    echo
    echo "The following components are always included:"
    echo -e "  ${GREEN}✓${RESET} MindGraph       — Python knowledge-graph core"
    echo -e "  ${GREEN}✓${RESET} MindReader UI   — Express server + React interface (port ${UI_PORT:-18900})"
    echo

    INCLUDE_OPENCLAW=false
    OPENCLAW_EXTENSIONS_PATH=""

    if ask_yn "Include OpenClaw Plugin? (optional integration for OpenClaw agents)" "N"; then
        INCLUDE_OPENCLAW=true
        echo

        # Auto-detect default OpenClaw extensions path
        local default_ext_path=""
        if [[ -d "$HOME/.openclaw/extensions" ]]; then
            default_ext_path="$HOME/.openclaw/extensions"
        fi

        info "OpenClaw plugin selected."
        echo "  The plugin files will be copied into your OpenClaw extensions directory."
        echo "  A node_modules symlink will be created so the plugin can find its dependencies."
        echo
        OPENCLAW_EXTENSIONS_PATH="$(ask "Path to your OpenClaw extensions directory" "${default_ext_path}")"

        if [[ ! -d "$OPENCLAW_EXTENSIONS_PATH" ]]; then
            warn "Directory does not exist: $OPENCLAW_EXTENSIONS_PATH"
            if ask_yn "Create it?" "Y"; then
                mkdir -p "$OPENCLAW_EXTENSIONS_PATH"
                success "Created $OPENCLAW_EXTENSIONS_PATH"
            fi
        fi
    fi
    echo
}

# ---------------------------------------------------------------------------
# Step 2: Neo4j
# ---------------------------------------------------------------------------
step_neo4j() {
    separator
    echo -e "${BOLD}Step 2: Neo4j Database${RESET}"
    separator
    echo

    NEO4J_URI="${NEO4J_URI:-bolt://localhost:7687}"
    NEO4J_USER="${NEO4J_USER:-neo4j}"
    NEO4J_PASSWORD="${NEO4J_PASSWORD:-mindreader-2026}"
    NEO4J_MANAGED=false

    if ask_yn "Do you have an existing Neo4j instance to connect to?" "N"; then
        info "Using existing Neo4j instance."
        NEO4J_URI="$(ask "Neo4j URI" "$NEO4J_URI")"
        NEO4J_USER="$(ask "Neo4j username" "$NEO4J_USER")"
        NEO4J_PASSWORD="$(ask_secret "Neo4j password" "$NEO4J_PASSWORD")"
    else
        NEO4J_MANAGED=true
        info "MindReader will start Neo4j via Docker."
        echo
        if ! command -v docker &>/dev/null; then
            error "Docker is not installed or not in PATH."
            error "Please install Docker and re-run setup, or provide an existing Neo4j URI."
            exit 1
        fi
        if ! docker info &>/dev/null 2>&1; then
            error "Docker daemon is not running. Please start Docker and re-run setup."
            exit 1
        fi
        success "Docker is available."

        # Let user set a password (passed to docker-compose via NEO4J_PASSWORD env)
        NEO4J_PASSWORD="$(ask "Neo4j password" "$NEO4J_PASSWORD")"

        info "Starting Neo4j container..."
        if NEO4J_PASSWORD="$NEO4J_PASSWORD" docker compose -f "$DOCKER_COMPOSE_FILE" up -d; then
            success "Neo4j container started."
            info "Waiting for Neo4j to become ready (first start may take 20-30s)..."
            # Poll until Neo4j HTTP API responds (max 60s)
            local http_uri="${NEO4J_URI/bolt:\/\//http://}"
            http_uri="${http_uri/:7687/:7474}"
            local ready=false
            for i in $(seq 1 12); do
                sleep 5
                local status
                status="$(curl -s -o /dev/null -w "%{http_code}" \
                    -u "${NEO4J_USER}:${NEO4J_PASSWORD}" \
                    -H "Content-Type: application/json" \
                    -d '{"statements":[{"statement":"RETURN 1"}]}' \
                    "${http_uri}/db/neo4j/tx/commit" 2>/dev/null)" || true
                if [[ "$status" == "200" ]]; then
                    ready=true
                    break
                fi
                printf "."
            done
            echo
            if [[ "$ready" == "true" ]]; then
                success "Neo4j is ready."
            else
                warn "Neo4j may still be starting. Verification will retry in Step 4."
            fi
        else
            error "Failed to start Neo4j container. Check $DOCKER_COMPOSE_FILE."
            exit 1
        fi
    fi
    echo
}

# ---------------------------------------------------------------------------
# Step 3: LLM Provider
# ---------------------------------------------------------------------------
step_llm() {
    separator
    echo -e "${BOLD}Step 3: LLM Provider${RESET}"
    separator
    echo
    echo "Select your LLM provider:"
    echo "  1) OpenAI    — gpt-4o-mini (default)"
    echo "  2) Anthropic — claude-sonnet-4-6 (native API support)"
    echo "  3) DashScope — qwen3.5-flash (Alibaba Cloud)"
    echo

    local llm_choice
    llm_choice="$(ask "Choice" "1")"

    case "$llm_choice" in
        1)
            LLM_PROVIDER="openai"
            LLM_BASE_URL="https://api.openai.com/v1"
            LLM_DEFAULT_MODEL="gpt-4o-mini"
            ;;
        2)
            LLM_PROVIDER="anthropic"
            LLM_BASE_URL="https://api.anthropic.com/v1"
            LLM_DEFAULT_MODEL="claude-sonnet-4-6"
            ;;
        3)
            LLM_PROVIDER="dashscope"
            LLM_BASE_URL="https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
            LLM_DEFAULT_MODEL="qwen3.5-flash"
            ;;
        *)
            warn "Invalid choice. Defaulting to OpenAI."
            LLM_PROVIDER="openai"
            LLM_BASE_URL="https://api.openai.com/v1"
            LLM_DEFAULT_MODEL="gpt-4o-mini"
            ;;
    esac

    info "Default model for ${LLM_PROVIDER}: ${LLM_DEFAULT_MODEL}"
    LLM_MODEL="$(ask "LLM model (press Enter to keep default)" "${LLM_MODEL:-$LLM_DEFAULT_MODEL}")"
    LLM_API_KEY="$(ask_secret "API key for ${LLM_PROVIDER}" "${LLM_API_KEY:-}")"

    # Node Evolve model (optional)
    echo
    info "Node Evolve uses a separate model with web search capability."
    info "Leave blank to use the same model as LLM_MODEL (${LLM_MODEL})."
    LLM_EVOLVE_MODEL="$(ask "Evolve model (blank = same as LLM)" "")"
    echo

    # Embedder
    separator
    echo -e "${BOLD}Step 3b: Embedder Provider${RESET}"
    separator
    echo
    echo "Select your embedder provider:"
    echo "  1) OpenAI    — text-embedding-3-small"
    echo "  2) DashScope — text-embedding-v4"
    echo "  3) Same as LLM provider"
    echo

    local emb_choice
    emb_choice="$(ask "Choice" "3")"

    case "$emb_choice" in
        1)
            EMBEDDER_PROVIDER="openai"
            EMBEDDER_BASE_URL="https://api.openai.com/v1"
            EMBEDDER_DEFAULT_MODEL="text-embedding-3-small"
            EMBEDDER_API_KEY="$(ask_secret "API key for OpenAI embedder (Enter to reuse LLM key)" "$LLM_API_KEY")"
            ;;
        2)
            EMBEDDER_PROVIDER="dashscope"
            EMBEDDER_BASE_URL="https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
            EMBEDDER_DEFAULT_MODEL="text-embedding-v4"
            EMBEDDER_API_KEY="$(ask_secret "API key for DashScope embedder (Enter to reuse LLM key)" "$LLM_API_KEY")"
            ;;
        3|*)
            if [[ "$LLM_PROVIDER" == "anthropic" ]]; then
                warn "Anthropic does not provide an embeddings API."
                info "Defaulting to OpenAI for embeddings. You'll need an OpenAI API key."
                EMBEDDER_PROVIDER="openai"
                EMBEDDER_BASE_URL="https://api.openai.com/v1"
                EMBEDDER_DEFAULT_MODEL="text-embedding-3-small"
                EMBEDDER_API_KEY="$(ask_secret "API key for OpenAI embedder" "${EMBEDDER_API_KEY:-}")"
            else
                EMBEDDER_PROVIDER="$LLM_PROVIDER"
                EMBEDDER_BASE_URL="$LLM_BASE_URL"
                EMBEDDER_API_KEY="$LLM_API_KEY"
                # Map provider to its default embedding model
                case "$EMBEDDER_PROVIDER" in
                    openai)    EMBEDDER_DEFAULT_MODEL="text-embedding-3-small" ;;
                    dashscope) EMBEDDER_DEFAULT_MODEL="text-embedding-v4" ;;
                    *)         EMBEDDER_DEFAULT_MODEL="text-embedding-3-small" ;;
                esac
                info "Using same provider as LLM: ${EMBEDDER_PROVIDER}"
            fi
            ;;
    esac

    EMBEDDER_MODEL="$(ask "Embedder model" "${EMBEDDER_MODEL:-$EMBEDDER_DEFAULT_MODEL}")"
    echo
}

# ---------------------------------------------------------------------------
# Step 4: Verify & Install
# ---------------------------------------------------------------------------
verify_neo4j() {
    info "Testing Neo4j connection at ${NEO4J_URI}..."
    local ok=false

    # Method 1: Try curl to Neo4j HTTP API (no dependencies needed)
    local http_uri="${NEO4J_URI/bolt:\/\//http://}"
    http_uri="${http_uri/:7687/:7474}"
    if command -v curl &>/dev/null; then
        local http_status
        http_status="$(curl -s -o /dev/null -w "%{http_code}" \
            -u "${NEO4J_USER}:${NEO4J_PASSWORD}" \
            -H "Content-Type: application/json" \
            -d '{"statements":[{"statement":"RETURN 1"}]}' \
            "${http_uri}/db/neo4j/tx/commit" 2>/dev/null)" || true
        if [[ "$http_status" == "200" ]]; then
            ok=true
        fi
    fi

    # Method 2: Try cypher-shell
    if [[ "$ok" == "false" ]] && command -v cypher-shell &>/dev/null; then
        if echo "RETURN 1;" | cypher-shell -u "$NEO4J_USER" -p "$NEO4J_PASSWORD" -a "$NEO4J_URI" 2>/dev/null; then
            ok=true
        fi
    fi

    # Method 3: Try via Node.js (only if neo4j-driver is installed)
    if [[ "$ok" == "false" ]] && command -v node &>/dev/null; then
        local neo4j_mod="$REPO_ROOT/node_modules/neo4j-driver"
        if [[ -d "$neo4j_mod" ]]; then
            if node --input-type=module -e "
import neo4j from 'neo4j-driver';
const driver = neo4j.driver('$NEO4J_URI', neo4j.auth.basic('$NEO4J_USER', '$NEO4J_PASSWORD'));
driver.verifyConnectivity().then(() => { console.log('OK'); process.exit(0); }).catch(() => process.exit(1));
" 2>/dev/null; then
                ok=true
            fi
        fi
    fi

    if [[ "$ok" == "true" ]]; then
        success "Neo4j connection verified."
        return 0
    else
        return 1
    fi
}

verify_llm() {
    info "Testing LLM API (${LLM_PROVIDER} / ${LLM_MODEL})..."
    if ! command -v python3 &>/dev/null; then
        warn "python3 not found — skipping LLM verification."
        return 0
    fi

    local test_output
    if [[ "$LLM_PROVIDER" == "anthropic" ]]; then
        test_output="$(LLM_API_KEY="$LLM_API_KEY" LLM_MODEL="$LLM_MODEL" python3 -c "
import os
try:
    import anthropic
except ImportError:
    from pip._internal.cli.main import main as pip_main
    pip_main(['install', '-q', 'anthropic'])
    import anthropic
c = anthropic.Anthropic(api_key=os.environ['LLM_API_KEY'])
r = c.messages.create(model=os.environ['LLM_MODEL'], messages=[{'role':'user','content':'Hi'}], max_tokens=5)
print('OK:', r.content[0].text)
" 2>&1)" && {
            success "LLM API verified: $test_output"
            return 0
        }
    else
        test_output="$(LLM_API_KEY="$LLM_API_KEY" LLM_BASE_URL="$LLM_BASE_URL" LLM_MODEL="$LLM_MODEL" python3 -c "
import os
from openai import OpenAI
c = OpenAI(api_key=os.environ['LLM_API_KEY'], base_url=os.environ['LLM_BASE_URL'])
r = c.chat.completions.create(model=os.environ['LLM_MODEL'], messages=[{'role':'user','content':'Hi'}], max_tokens=5)
print('OK:', r.choices[0].message.content)
" 2>&1)" && {
            success "LLM API verified: $test_output"
            return 0
        }
    fi
    return 1
}

install_python_venv() {
    info "Setting up Python virtual environment..."
    if [[ ! -d "$VENV_DIR" ]]; then
        python3 -m venv "$VENV_DIR"
    fi
    "$VENV_DIR/bin/pip" install --quiet --upgrade pip
    "$VENV_DIR/bin/pip" install --quiet -r "$PYTHON_DIR/requirements.txt"
    success "Python venv ready at $VENV_DIR"
}

install_npm() {
    info "Running npm install..."
    (cd "$REPO_ROOT" && npm install --silent)
    success "npm dependencies installed."
}

build_ui() {
    info "Building React UI..."
    (cd "$REPO_ROOT" && npm run build --silent 2>&1 | tail -5)
    success "UI build complete."
}

init_neo4j_indexes() {
    info "Initialising Neo4j indexes..."
    if [[ -f "$PYTHON_DIR/init_db.py" ]]; then
        "$VENV_DIR/bin/python" "$PYTHON_DIR/init_db.py" 2>/dev/null && success "Neo4j indexes initialised." || warn "Index init script failed — you may need to run it manually."
    else
        warn "No init_db.py found — skipping index initialisation."
    fi
}

install_openclaw_plugin() {
    info "Installing OpenClaw plugin..."
    local plugin_src="$REPO_ROOT/packages/openclaw-plugin"
    local plugin_dest="$OPENCLAW_EXTENSIONS_PATH/mindreader"

    # Check if destination already exists
    if [[ -d "$plugin_dest" ]] || [[ -L "$plugin_dest" ]]; then
        warn "Extension directory already exists: $plugin_dest"
        if ask_yn "Replace it?" "Y"; then
            # Back up if it's a real directory (not a symlink)
            if [[ -d "$plugin_dest" ]] && [[ ! -L "$plugin_dest" ]]; then
                local backup_dir="${plugin_dest}.backup-$(date +%Y%m%d%H%M%S)"
                mv "$plugin_dest" "$backup_dir"
                info "Old extension backed up to: $backup_dir"
            else
                rm -f "$plugin_dest"
            fi
        else
            warn "Skipping OpenClaw plugin installation."
            return
        fi
    fi

    # Create extension directory and copy plugin files
    mkdir -p "$plugin_dest"
    cp "$plugin_src/index.js" "$plugin_dest/"
    cp "$plugin_src/package.json" "$plugin_dest/"
    cp "$plugin_src/openclaw.plugin.json" "$plugin_dest/"

    # Symlink node_modules so @mindreader/ui resolves at runtime
    # (OpenClaw's boundary check rejects full-directory symlinks, but
    #  node_modules symlinks work because Node resolves them internally)
    ln -sf "$REPO_ROOT/node_modules" "$plugin_dest/node_modules"

    success "Plugin installed to: $plugin_dest"
    echo
    echo "  Next steps for OpenClaw:"
    echo "    1. Ensure 'mindreader' is in your openclaw.json plugins.entries"
    echo "    2. Set plugins.slots.memory to 'mindreader'"
    echo "    3. Restart OpenClaw:  openclaw gateway restart"
    echo
    warn "When you update MindReader, re-run this step or copy the plugin files:"
    echo "    cp $plugin_src/{index.js,package.json,openclaw.plugin.json} $plugin_dest/"
}

step_verify_install() {
    separator
    echo -e "${BOLD}Step 4: Verify & Install${RESET}"
    separator
    echo

    # Neo4j verification loop
    local neo4j_attempts=0
    while true; do
        neo4j_attempts=$((neo4j_attempts + 1))
        if verify_neo4j; then
            break
        fi
        error "Could not connect to Neo4j at ${NEO4J_URI}."
        if [[ $neo4j_attempts -ge 3 ]]; then
            warn "Neo4j verification failed after ${neo4j_attempts} attempts."
            if ask_yn "Skip Neo4j verification and continue anyway?" "N"; then
                warn "Skipping Neo4j verification. The app may not function correctly."
                break
            else
                NEO4J_URI="$(ask "Re-enter Neo4j URI" "$NEO4J_URI")"
                NEO4J_USER="$(ask "Re-enter Neo4j username" "$NEO4J_USER")"
                NEO4J_PASSWORD="$(ask_secret "Re-enter Neo4j password" "$NEO4J_PASSWORD")"
            fi
        else
            if ask_yn "Retry Neo4j connection?" "Y"; then
                continue
            else
                warn "Skipping Neo4j verification."
                break
            fi
        fi
    done

    # LLM verification loop
    local llm_attempts=0
    while true; do
        llm_attempts=$((llm_attempts + 1))
        if verify_llm; then
            break
        fi
        error "LLM API test failed for provider '${LLM_PROVIDER}'."
        if [[ $llm_attempts -ge 2 ]]; then
            if ask_yn "Skip LLM verification and continue anyway?" "N"; then
                warn "Skipping LLM verification. Check your API key and base URL."
                break
            else
                LLM_API_KEY="$(ask_secret "Re-enter API key for ${LLM_PROVIDER}" "$LLM_API_KEY")"
            fi
        else
            if ask_yn "Retry LLM API test?" "Y"; then
                continue
            else
                warn "Skipping LLM verification."
                break
            fi
        fi
    done

    # Install dependencies
    if command -v python3 &>/dev/null; then
        install_python_venv || warn "Python venv setup encountered errors."
    else
        warn "python3 not found — skipping Python venv setup."
    fi

    if command -v npm &>/dev/null; then
        install_npm || warn "npm install encountered errors."
        build_ui  || warn "UI build encountered errors."
    else
        warn "npm not found — skipping JavaScript dependency installation."
    fi

    init_neo4j_indexes

    # Install OpenClaw plugin if selected
    if [[ "$INCLUDE_OPENCLAW" == "true" ]] && [[ -n "$OPENCLAW_EXTENSIONS_PATH" ]]; then
        install_openclaw_plugin
    fi

    echo
}

# ---------------------------------------------------------------------------
# Write .env
# ---------------------------------------------------------------------------
write_env() {
    separator
    echo -e "${BOLD}Writing .env${RESET}"
    separator
    echo

    local ui_port="${UI_PORT:-18900}"

    cat > "$ENV_FILE" <<EOF
# MindReader Configuration
# Generated by setup.sh on $(date -u +"%Y-%m-%dT%H:%M:%SZ")

# ── UI ──────────────────────────────────────────────────────────────────────
UI_PORT=${ui_port}

# ── Neo4j ───────────────────────────────────────────────────────────────────
NEO4J_URI=${NEO4J_URI}
NEO4J_USER=${NEO4J_USER}
NEO4J_PASSWORD=${NEO4J_PASSWORD}

# ── LLM Provider ────────────────────────────────────────────────────────────
LLM_PROVIDER=${LLM_PROVIDER}
LLM_BASE_URL=${LLM_BASE_URL}
LLM_MODEL=${LLM_MODEL}
LLM_API_KEY=${LLM_API_KEY}
LLM_EVOLVE_MODEL=${LLM_EVOLVE_MODEL}

# ── Embedder ─────────────────────────────────────────────────────────────────
EMBEDDER_PROVIDER=${EMBEDDER_PROVIDER}
EMBEDDER_BASE_URL=${EMBEDDER_BASE_URL}
EMBEDDER_MODEL=${EMBEDDER_MODEL}
EMBEDDER_API_KEY=${EMBEDDER_API_KEY}
EOF

    if [[ "$INCLUDE_OPENCLAW" == "true" ]]; then
        cat >> "$ENV_FILE" <<EOF

# ── OpenClaw Plugin ──────────────────────────────────────────────────────────
OPENCLAW_EXTENSIONS_PATH=${OPENCLAW_EXTENSIONS_PATH}
EOF
    fi

    success ".env written to $ENV_FILE"
    echo
}

# ---------------------------------------------------------------------------
# CLI alias
# ---------------------------------------------------------------------------
step_alias() {
    separator
    echo -e "${BOLD}CLI Alias (optional)${RESET}"
    separator
    echo

    local shell_rc=""
    if [[ -n "${ZSH_VERSION:-}" ]] || [[ "${SHELL:-}" == *zsh* ]]; then
        shell_rc="$HOME/.zshrc"
    else
        shell_rc="$HOME/.bashrc"
    fi

    local alias_line="alias mg='python3 ${MG_CLI}'"

    if ask_yn "Add 'mg' alias to ${shell_rc}?" "Y"; then
        if grep -qF "$alias_line" "$shell_rc" 2>/dev/null; then
            info "Alias already present in ${shell_rc} — skipping."
        else
            echo "" >> "$shell_rc"
            echo "# MindReader CLI alias" >> "$shell_rc"
            echo "$alias_line" >> "$shell_rc"
            success "Alias added. Run: source ${shell_rc}  (or open a new terminal)"
        fi
    else
        info "Skipping alias. You can add it manually:"
        echo "  $alias_line"
    fi
    echo
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
print_summary() {
    separator
    echo -e "${GREEN}${BOLD}Setup Complete!${RESET}"
    separator
    echo
    echo -e "${BOLD}Configuration Summary:${RESET}"
    echo -e "  Neo4j URI      : ${NEO4J_URI}"
    echo -e "  Neo4j User     : ${NEO4J_USER}"
    echo -e "  LLM Provider   : ${LLM_PROVIDER} (${LLM_MODEL})"
    echo -e "  Embedder       : ${EMBEDDER_PROVIDER} (${EMBEDDER_MODEL})"
    echo -e "  OpenClaw       : $( [[ "$INCLUDE_OPENCLAW" == "true" ]] && echo "Enabled — ${OPENCLAW_EXTENSIONS_PATH}" || echo "Not included" )"
    echo -e "  UI Port        : ${UI_PORT:-18900}"
    echo
    echo -e "${BOLD}To start MindReader:${RESET}"
    echo -e "  ${CYAN}npm run dev${RESET}           — development mode (hot reload)"
    echo -e "  ${CYAN}npm start${RESET}             — production mode"
    echo
    if [[ "$NEO4J_MANAGED" == "true" ]]; then
        echo -e "${BOLD}To manage Neo4j:${RESET}"
        echo -e "  ${CYAN}docker compose -f ${DOCKER_COMPOSE_FILE} up -d${RESET}    — start"
        echo -e "  ${CYAN}docker compose -f ${DOCKER_COMPOSE_FILE} down${RESET}     — stop"
        echo
    fi
    echo -e "${BOLD}MindGraph CLI:${RESET}"
    echo -e "  ${CYAN}python3 ${MG_CLI} --help${RESET}"
    echo -e "  or simply ${CYAN}mg --help${RESET} if you added the alias."
    echo
    separator
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
    print_banner

    check_prerequisites
    handle_existing_env

    step_components
    step_neo4j
    step_llm
    step_verify_install

    write_env
    step_alias
    print_summary
}

main "$@"
