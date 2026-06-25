# nix/lib.nix — Shared helpers for nix stuff
#
# All npm packages in this repo are workspace members sharing a single
# root package-lock.json.  mkNpmPassthru provides the shared src, npmDeps,
# npmRoot, and npmConfigHook so individual .nix files don't duplicate them.
#
# mkNpmPassthru returns packageJsonPath (e.g. "ui-tui/package.json")
# instead of a per-package devShellHook.  The root devshell hook
# (mkNpmDevShellHook) collects all package.json paths, stamps them,
# and if any changed, runs a single `npm i --package-lock-only` from
# root to update the lockfile, then `npm ci` if the lockfile changed.
{
  pkgs,
  npm-lockfile-fix,
  nodejs,
}:
let
  # The workspace root — where the single package-lock.json lives.
  src = ../.;

  # npm dependencies for the workspace, shared by all members. importNpmLock
  # resolves each package from the lockfile's own `integrity` hashes, so the
  # lockfile is the single source of truth — no separate dependency hash to
  # keep in sync with it.
  npmDeps = pkgs.importNpmLock.importNpmLock { npmRoot = src; };
in
{
  # Returns a buildNpmPackage-compatible attrs set that provides:
  #   src, npmDeps, npmRoot      — workspace source + importNpmLock dep set
  #   npmConfigHook              — importNpmLock's offline `npm install` hook
  #   nativeBuildInputs          — [ updateLockfileScript ] (list, prepend with ++ for more)
  #   passthru.packageJsonPath   — relative path to this workspace's package.json
  #   nodejs                     — fixed nodejs version for all packages we use in the repo
  #
  # Usage:
  #   npm = hermesNpmLib.mkNpmPassthru { folder = "ui-tui"; attr = "tui"; pname = "hermes-tui"; };
  #   pkgs.buildNpmPackage (npm // { ... } # or:
  #   pkgs.buildNpmPackage ({ ... } // npm)
  mkNpmPassthru =
    {
      folder, # repo-relative folder with package.json, e.g. "ui-tui"
      attr, # flake package attr, e.g. "tui"
      pname, # e.g. "hermes-tui"
      nixFile ? "nix/${attr}.nix", # defaults to nix/<attr>.nix
    }:
    {
      inherit src npmDeps nodejs;
      # importNpmLock's hook installs the rewritten lockfile (every `resolved`
      # rewritten to a /nix/store file: path) into the unpacked workspace and
      # runs `npm install` offline, so every workspace member's dependencies
      # resolve without network access.
      npmConfigHook = pkgs.importNpmLock.npmConfigHook;
      npmRoot = ".";

      ELECTRON_SKIP_BINARY_DOWNLOAD = 1;

      nativeBuildInputs = [
        (pkgs.writeShellScriptBin "update_${attr}_lockfile" ''
          set -euox pipefail

          REPO_ROOT=$(git rev-parse --show-toplevel)

          cd "$REPO_ROOT/${folder}"
          rm -rf node_modules/
          ${pkgs.lib.getExe' nodejs "npm"} cache clean --force
          CI=true ${pkgs.lib.getExe' nodejs "npm"} install
          ${pkgs.lib.getExe npm-lockfile-fix} ./package-lock.json

          nix build .#${attr}
          echo "Updated npm hash in $NIX_FILE to $NEW_HASH"
        '')
      ];

      passthru = {
        devShellHook = pkgs.writeShellScript "npm-dev-hook-${pname}" ''
          REPO_ROOT=$(git rev-parse --show-toplevel)

          _hermes_npm_stamp() {
            sha256sum "${folder}/package.json" "${folder}/package-lock.json" \
              2>/dev/null | sha256sum | awk '{print $1}'
          }
          STAMP=".nix-stamps/${pname}"
          STAMP_VALUE="$(_hermes_npm_stamp)"
          if [ ! -f "$STAMP" ] || [ "$(cat "$STAMP")" != "$STAMP_VALUE" ]; then
            echo "${pname}: installing npm dependencies..."
            ( cd ${folder} && CI=true ${pkgs.lib.getExe' nodejs "npm"} install --silent --no-fund --no-audit 2>/dev/null )

            # Auto-update the nix hash so it stays in sync with the lockfile
            echo "${pname}: prefetching npm deps..."
            NIX_FILE="$REPO_ROOT/${nixFile}"
            if NEW_HASH=$(${pkgs.lib.getExe pkgs.prefetch-npm-deps} "${folder}/package-lock.json" 2>/dev/null); then
              sed -i "s|hash = \"sha256-[A-Za-z0-9+/=]+\"|hash = \"$NEW_HASH\";|" "$NIX_FILE"
              echo "${pname}: updated hash to $NEW_HASH"
            else
              echo "${pname}: warning: prefetch failed, run 'nix run .#fix-lockfiles' manually" >&2
            fi

            mkdir -p .nix-stamps
            _hermes_npm_stamp > "$STAMP"
          fi
          unset -f _hermes_npm_stamp
        '';

        npmLockfile = {
          inherit attr folder nixFile;
        };
      };
    };

  # Single devshell hook for all npm workspace packages.
  #
  # Takes a list of package.json relative paths (from mkNpmPassthru .passthru.packageJsonPath),
  # stamps all of them, and if any changed:
  #   1. Runs `npm i --package-lock-only` from root to update the lockfile
  #   2. If the lockfile changed, runs `npm ci`
  mkNpmDevShellHook =
    packageJsonPaths:
    pkgs.writeShellScript "npm-dev-hook" ''
      REPO_ROOT=$(git rev-parse --show-toplevel)

      # Stamp all workspace package.jsons into one file.
      STAMP_DIR=".nix-stamps"
      STAMP="$STAMP_DIR/npm-package-jsons"
      STAMP_VALUE=$(
        ${pkgs.coreutils}/bin/sha256sum ${
          pkgs.lib.concatMapStringsSep " " (p: "\"$REPO_ROOT/${p}\"") packageJsonPaths
        } 2>/dev/null | ${pkgs.coreutils}/bin/sort | ${pkgs.coreutils}/bin/sha256sum | awk '{print $1}'
      )

      PKG_CHANGED=false
      if [ ! -f "$STAMP" ] || [ "$(cat "$STAMP")" != "$STAMP_VALUE" ]; then
        PKG_CHANGED=true
        echo "npm: package.json changed, updating lockfile..."
        ( cd "$REPO_ROOT" && ${pkgs.lib.getExe' nodejs "npm"} i --package-lock-only --silent --no-fund --no-audit 2>/dev/null )
        mkdir -p "$STAMP_DIR"
        echo "$STAMP_VALUE" > "$STAMP"
      fi

      # Check if lockfile changed (either from the npm i above or from an
      # external edit).  Runs npm ci if so.
      LOCK_STAMP="$STAMP_DIR/root-lockfile"
      LOCK_STAMP_VALUE=$(sha256sum "$REPO_ROOT/package-lock.json" 2>/dev/null | awk '{print $1}')
      if [ ! -f "$LOCK_STAMP" ] || [ "$(cat "$LOCK_STAMP")" != "$LOCK_STAMP_VALUE" ]; then
        echo "npm: package-lock.json changed, running npm ci..."
        ( cd "$REPO_ROOT" && CI=true ${pkgs.lib.getExe' nodejs "npm"} ci --silent --no-fund --no-audit 2>/dev/null )
        mkdir -p "$STAMP_DIR"
        echo "$LOCK_STAMP_VALUE" > "$LOCK_STAMP"
      fi
    '';
}
