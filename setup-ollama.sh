#!/bin/bash
# One-time Ollama setup for the LinkedIn AI Slop Filter extension (macOS).
# 1. Checks Ollama is installed
# 2. Allows Chrome extensions to call the Ollama API (OLLAMA_ORIGINS)
# 3. Pulls the default classification model

set -e

MODEL="${1:-qwen2.5:3b}"

if ! command -v ollama >/dev/null 2>&1; then
  echo "Ollama is not installed."
  echo "Install it with:  brew install ollama"
  echo "or download from: https://ollama.com/download"
  exit 1
fi

echo "==> Allowing Chrome extensions to call Ollama (OLLAMA_ORIGINS)..."
launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"

# launchctl setenv does not persist across reboots; install a LaunchAgent to reapply it.
AGENT=~/Library/LaunchAgents/com.user.ollama-origins.plist
cat > "$AGENT" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.user.ollama-origins</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/launchctl</string>
    <string>setenv</string>
    <string>OLLAMA_ORIGINS</string>
    <string>chrome-extension://*</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
EOF
launchctl load -w "$AGENT" 2>/dev/null || true
echo "    Done (persisted via LaunchAgent)."

echo "==> Restarting Ollama so it picks up the new setting..."
if pgrep -x "Ollama" >/dev/null 2>&1; then
  osascript -e 'quit app "Ollama"' 2>/dev/null || true
  sleep 2
  open -a Ollama 2>/dev/null || true
elif pgrep -x "ollama" >/dev/null 2>&1; then
  echo "    Ollama appears to be running via 'ollama serve' in a terminal."
  echo "    Stop it and restart with:  OLLAMA_ORIGINS='chrome-extension://*' ollama serve"
else
  open -a Ollama 2>/dev/null || echo "    Start Ollama manually (Ollama.app or 'ollama serve')."
fi
sleep 3

echo "==> Pulling model: $MODEL (a few GB on first run)..."
ollama pull "$MODEL"

echo ""
echo "Setup complete. Load the extension in Chrome (chrome://extensions → Load unpacked)"
echo "and check the popup shows Ollama as 'running'."
