# nix/devShell.nix — Dev shell that delegates setup to each package
#
# Each package in inputsFrom might expose passthru.devShellHook — a bash snippet
# with stamp-checked setup logic. This file collects and runs them all.
{ ... }:
{
  perSystem =
    { pkgs, self', ... }:
    let
      packages = builtins.attrValues self'.packages;
      hermesNpmLib = self'.packages.default.passthru.hermesNpmLib;

      # Collect all packageJsonPath values from npm workspace packages.
      npmPackageJsonPaths = builtins.filter (p: p != null) (
        map (p: p.passthru.packageJsonPath or null) packages
      );

      # Non-npm packages may have their own devShellHook (e.g. hermes-agent
      # stamps pyproject.toml + uv.lock for Python venv setup).
      nonNpmHooks = map (p: p.passthru.devShellHook or "") packages;
      combinedNonNpm = pkgs.lib.concatStringsSep "\n" (builtins.filter (h: h != "") nonNpmHooks);
    in
    {
      devShells.default = pkgs.mkShell {
        inputsFrom = packages;
        packages = with pkgs; [
          uv
        ];
        shellHook = ''
          echo "Hermes Agent dev shell"
          ${combinedNonNpm}
          ${hermesNpmLib.mkNpmDevShellHook npmPackageJsonPaths}
          echo "Ready. Run 'hermes' to start."
        '';
      };
    };
}
