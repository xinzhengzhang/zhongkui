import { exec } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import { join } from 'path';
import { FileChange } from '../types';
import { logger } from '../utils/logger';

const execAsync = promisify(exec);

/**
 * Analyzes file changes to determine which Bazel packages are impacted
 */
export class DiffAnalyzer {
  private repoRoot: string;
  
  constructor(repoRoot: string) {
    this.repoRoot = repoRoot;
  }

  /**
   * Analyze file changes in the repository and map to Bazel packages accurately
   */
  async analyzeChanges(repoRoot: string, baseBranch = 'origin/master'): Promise<FileChange[]> {
    logger.info(`Analyzing file changes in ${repoRoot}`);
    
    try {
      // Get committed changes between base branch and HEAD
      const committedCommand = `cd ${repoRoot} && git diff --name-status ${baseBranch}...HEAD`;
      logger.info(`Executing git diff command for committed changes: ${committedCommand}`);
      
      // Get uncommitted changes (both staged and unstaged)
      const uncommittedCommand = `cd ${repoRoot} && git diff --name-status HEAD`;
      logger.info(`Executing git diff command for uncommitted changes: ${uncommittedCommand}`);
      
      const [committedResult, uncommittedResult] = await Promise.all([
        execAsync(committedCommand).catch(() => ({ stdout: '' })),
        execAsync(uncommittedCommand).catch(() => ({ stdout: '' }))
      ]);
      
      const combinedOutput = [committedResult.stdout, uncommittedResult.stdout]
        .filter(output => output.trim())
        .join('\n');
      
      logger.info(`Combined git diff output length: ${combinedOutput.length} characters`);
      
      return await this.parseGitDiffWithBuildFileMapping(combinedOutput);
    } catch (error) {
      logger.error('Failed to analyze file changes:', error);
      throw error;
    }
  }

  /**
   * Parse git diff output and find Bazel packages by locating BUILD files
   */
  private async parseGitDiffWithBuildFileMapping(diffOutput: string): Promise<FileChange[]> {
    const lines = diffOutput.trim().split('\n').filter(line => line);
    const changes: FileChange[] = [];

    for (const line of lines) {
      const [status, path] = line.split('\t');
      if (!path) continue;

      const changeType = this.mapGitStatus(status);
      
      // Find the package by looking for the first BUILD file in parent directories
      const packagePath = await this.findPackageByBuildFile(path);

      changes.push({
        path,
        changeType,
        package: packagePath
      });
    }

    // Debug: log detected packages
    const packages = [...new Set(changes.map(c => c.package))];
    logger.info(`Detected ${changes.length} file changes in ${packages.length} packages: ${packages.join(', ')}`);

    return changes;
  }

  /**
   * Find the Bazel package for a file by locating the nearest BUILD file
   */
  private async findPackageByBuildFile(filePath: string): Promise<string> {
    const parts = filePath.split('/');
    
    // Start from the file's directory and work up the hierarchy
    for (let i = parts.length - 1; i >= 0; i--) {
      const dirPath = parts.slice(0, i).join('/');
      const fullDirPath = dirPath ? join(this.repoRoot, dirPath) : this.repoRoot;
      
      // Check for BUILD or BUILD.bazel files
      const buildPath = join(fullDirPath, 'BUILD');
      const buildBazelPath = join(fullDirPath, 'BUILD.bazel');
      
      try {
        // Check if either BUILD file exists
        const [buildExists, buildBazelExists] = await Promise.all([
          this.fileExists(buildPath),
          this.fileExists(buildBazelPath)
        ]);
        
        if (buildExists || buildBazelExists) {
          return dirPath || '.';
        }
      } catch (error) {
        logger.debug(`Error checking BUILD files in ${fullDirPath}:`, error);
      }
    }
    
    // If no BUILD file found, return root package
    return '.';
  }

  /**
   * Check if a file exists
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Map git status to change type
   */
  private mapGitStatus(status: string): FileChange['changeType'] {
    switch (status) {
      case 'A': return 'added';
      case 'D': return 'deleted';
      case 'M':
      case 'R':
      case 'C':
      default:
        return 'modified';
    }
  }

  /**
   * Get all files that belong to a specific Bazel package
   */
  async getPackageFiles(repoRoot: string, packagePath: string): Promise<string[]> {
    try {
      const { stdout } = await execAsync(`cd ${repoRoot} && find ${packagePath} -type f`);
      return stdout.trim().split('\n').filter(line => line);
    } catch (error) {
      logger.error(`Failed to get files for package ${packagePath}:`, error);
      return [];
    }
  }
}