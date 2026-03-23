#!/bin/bash
# MindReader — Python environment setup
# Creates a virtual environment and installs Graphiti + dependencies

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "🧠 MindReader — Setting up Python environment..."

# Check Python version
PYTHON=${PYTHON:-python3}
PY_VERSION=$($PYTHON --version 2>&1 | grep -oP '\d+\.\d+')
PY_MAJOR=$(echo "$PY_VERSION" | cut -d. -f1)
PY_MINOR=$(echo "$PY_VERSION" | cut -d. -f2)

if [ "$PY_MAJOR" -lt 3 ] || ([ "$PY_MAJOR" -eq 3 ] && [ "$PY_MINOR" -lt 10 ]); then
  echo "❌ Python 3.10+ required (found $PY_VERSION)"
  exit 1
fi

echo "✅ Python $PY_VERSION detected"

# Create venv
if [ ! -d ".venv" ]; then
  echo "📦 Creating virtual environment..."
  $PYTHON -m venv .venv
fi

# Activate and install
source .venv/bin/activate
echo "📦 Installing dependencies..."
pip install --quiet --upgrade pip
pip install --quiet -r requirements.txt

echo ""
echo "✅ Setup complete!"
echo ""
echo "Next steps:"
echo "  1. Copy .env.example to .env and configure your settings"
echo "  2. Start Neo4j: cd ../docker && docker compose up -d"
echo "  3. Test: source .venv/bin/activate && python mg_cli.py status"
