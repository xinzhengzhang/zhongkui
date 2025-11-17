import { readdir, stat } from 'fs/promises';
import { join } from 'path';
import { createReadStream, createWriteStream } from 'fs';
import { createGunzip } from 'zlib';
import { pipeline } from 'stream/promises';
import { spawn } from 'child_process';
import { logger } from '../utils/logger';
import { mkdtemp, unlink } from 'fs/promises';
import { tmpdir } from 'os';

/**
 * Locate and prepare Bazel profile files from output_base
 */
export class ProfileLocator {
  /**
   * Get Bazel's output_base directory
   */
  private async getOutputBase(repoRoot: string, bazelBinary: string = 'bazel', startupOpts: string = ''): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = [];

      // Add startup options first
      if (startupOpts) {
        args.push(...startupOpts.split(/\s+/).filter(arg => arg));
      }

      args.push('info', 'output_base');

      logger.debug(`Executing: ${bazelBinary} ${args.join(' ')}`);

      const child = spawn(bazelBinary, args, {
        cwd: repoRoot,
        stdio: ['inherit', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        if (code === 0) {
          const outputBase = stdout.trim();
          logger.info(`Bazel output_base: ${outputBase}`);
          resolve(outputBase);
        } else {
          reject(new Error(`Failed to get output_base: ${stderr}`));
        }
      });

      child.on('error', (error) => {
        reject(error);
      });
    });
  }

  /**
   * Find the latest profile file in output_base
   * Profile files are named: command-{invocation_id}.profile.gz
   */
  private async findLatestProfile(outputBase: string): Promise<string | null> {
    try {
      const files = await readdir(outputBase);

      // Filter for profile files matching pattern: command-*.profile.gz
      const profileFiles = files.filter(file =>
        file.startsWith('command-') && file.endsWith('.profile.gz')
      );

      if (profileFiles.length === 0) {
        logger.warn('No profile files found in output_base');
        return null;
      }

      // Sort by modification time to get the latest
      const filesWithStats = await Promise.all(
        profileFiles.map(async (file) => {
          const filePath = join(outputBase, file);
          const stats = await stat(filePath);
          return { file, path: filePath, mtime: stats.mtime };
        })
      );

      // Sort by modification time (newest first)
      filesWithStats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

      const latestProfile = filesWithStats[0];
      logger.info(`Found latest profile: ${latestProfile.file} (modified: ${latestProfile.mtime.toISOString()})`);

      return latestProfile.path;
    } catch (error) {
      logger.error('Failed to find profile files in output_base:', error);
      return null;
    }
  }

  /**
   * Decompress a .gz profile file to a temporary location
   */
  private async decompressProfile(gzipPath: string): Promise<string> {
    // Create temporary file for decompressed profile
    const tempDir = await mkdtemp(join(tmpdir(), 'zhongkui-profile-'));
    const outputPath = join(tempDir, 'profile.json');

    logger.info(`Decompressing ${gzipPath} to ${outputPath}`);

    try {
      const source = createReadStream(gzipPath);
      const destination = createWriteStream(outputPath);
      const gunzip = createGunzip();

      await pipeline(source, gunzip, destination);

      logger.info('Profile decompression completed successfully');
      return outputPath;
    } catch (error) {
      // Clean up on error
      try {
        await unlink(outputPath);
      } catch (cleanupError) {
        // Ignore cleanup errors
      }

      logger.error('Failed to decompress profile:', error);
      throw error;
    }
  }

  /**
   * Locate and prepare the default Bazel profile file
   * Returns the path to a decompressed JSON profile file
   *
   * @param repoRoot - Repository root directory
   * @param bazelBinary - Path to bazel binary
   * @param startupOpts - Bazel startup options
   * @returns Object containing the profile path and whether it's temporary (needs cleanup)
   */
  async locateDefaultProfile(
    repoRoot: string,
    bazelBinary: string = 'bazel',
    startupOpts: string = ''
  ): Promise<{ profilePath: string; isTemporary: boolean }> {
    logger.info('Locating default Bazel profile in output_base');

    // Get output_base directory
    const outputBase = await this.getOutputBase(repoRoot, bazelBinary, startupOpts);

    // Find the latest profile file
    const gzipProfilePath = await this.findLatestProfile(outputBase);

    if (!gzipProfilePath) {
      throw new Error('No profile file found in output_base. Bazel may not have generated a profile for the last build.');
    }

    // Decompress the profile
    const decompressedPath = await this.decompressProfile(gzipProfilePath);

    return {
      profilePath: decompressedPath,
      isTemporary: true
    };
  }
}
