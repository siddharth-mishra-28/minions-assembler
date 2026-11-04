#!/usr/bin/env bash
# Rootless build bootstrap for the GitLab shell runner.
# Guarantees a user-local npm prefix, a JDK >= 17 and Maven 3.9 without apt.
set -eo pipefail

ROOT="${CI_PROJECT_DIR:-$(pwd)}"
export NPM_CONFIG_PREFIX="$ROOT/.npm-global"
export PATH="$NPM_CONFIG_PREFIX/bin:$ROOT/tools/bin:$PATH"
mkdir -p "$ROOT/tools"

java_ok=0
if command -v java >/dev/null 2>&1; then
  major="$(java -version 2>&1 | head -1 | sed -E 's/.*"([0-9]+).*/\1/')"
  if [ -n "${major:-}" ] && [ "$major" -ge 17 ] 2>/dev/null; then java_ok=1; fi
fi

if [ "$java_ok" -eq 0 ]; then
  case "$(uname -m)" in
    aarch64|arm64) arch=aarch64 ;;
    *) arch=x64 ;;
  esac
  if [ ! -x "$ROOT/tools/jdk/bin/java" ]; then
    echo "bootstrap: downloading Temurin JDK 17 ($arch)"
    curl -fsSL --retry 3 -o "$ROOT/tools/jdk.tar.gz" \
      "https://api.adoptium.net/v3/binary/latest/17/ga/linux/$arch/jdk/hotspot/normal/eclipse"
    mkdir -p "$ROOT/tools/jdk"
    tar -xzf "$ROOT/tools/jdk.tar.gz" -C "$ROOT/tools/jdk" --strip-components=1
  fi
  export JAVA_HOME="$ROOT/tools/jdk"
  export PATH="$JAVA_HOME/bin:$PATH"
fi

if ! command -v mvn >/dev/null 2>&1; then
  if [ ! -x "$ROOT/tools/apache-maven-3.9.9/bin/mvn" ]; then
    echo "bootstrap: downloading Maven 3.9.9"
    curl -fsSL --retry 3 -o "$ROOT/tools/maven.tar.gz" \
      "https://archive.apache.org/dist/maven/maven-3/3.9.9/binaries/apache-maven-3.9.9-bin.tar.gz"
    tar -xzf "$ROOT/tools/maven.tar.gz" -C "$ROOT/tools"
  fi
  export PATH="$ROOT/tools/apache-maven-3.9.9/bin:$PATH"
fi

java -version
mvn -v | head -3
node -v
npm -v
