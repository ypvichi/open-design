import { cp, mkdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Constructs the `.output` target filename in the form:
 * `open-design-iux-{version}-{platform}-{arch}{suffix}`
 *
 * The suffix typically includes the leading separator and the file extension.
 * Examples:
 *   outputArtifactName("0.16.1", "win", "x64", "-setup.exe")
 *   → "open-design-iux-0.16.1-win-x64-setup.exe"
 *   outputArtifactName("0.16.1", "mac", "arm64", ".dmg")
 *   → "open-design-iux-0.16.1-mac-arm64.dmg"
 *   outputArtifactName("0.16.1", "linux", "x64", ".AppImage")
 *   → "open-design-iux-0.16.1-linux-x64.AppImage"
 */
export function outputArtifactName(
  version: string,
  platform: string,
  arch: string,
  suffix: string,
): string {
  return `open-design-iux-${version}-${platform}-${arch}${suffix}`;
}

/**
 * Copies a single build artifact to the project root `.output/` directory.
 */
export async function copyArtifactToOutput(
  workspaceRoot: string,
  source: string,
  targetName: string,
): Promise<string> {
  const outputDir = join(workspaceRoot, ".output");
  await mkdir(outputDir, { recursive: true });
  const destPath = join(outputDir, targetName);
  await cp(source, destPath);
  return destPath;
}