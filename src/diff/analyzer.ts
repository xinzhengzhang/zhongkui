import { exec } from 'child_process';
import { promisify } from 'util';
import { FileChange } from '../types';
import { logger } from '../utils/logger';

const execAsync = promisify(exec);

/**
 * Analyzes file changes to determine which Bazel packages are impacted
 */
export class DiffAnalyzer {
  /**
   * Analyze file changes in the repository
   */
  async analyzeChanges(repoRoot: string, baseBranch = 'origin/main'): Promise<FileChange[]> {
    logger.info(`Analyzing file changes in ${repoRoot}`);
    
    try {
      const { stdout } = await execAsync(`cd ${repoRoot} && git diff --name-status ${baseBranch}...HEAD`);
      return this.parseGitDiff(stdout);
    } catch (error) {
      logger.error('Failed to analyze file changes:', error);
      throw error;
    }
  }

  /**
   * Parse git diff output to extract file changes
   */
  private parseGitDiff(diffOutput: string): FileChange[] {
    const lines = diffOutput.trim().split('\n').filter(line => line);
    const changes: FileChange[] = [];

    for (const line of lines) {
      const [status, path] = line.split('\t');
      if (!path) continue;

      const changeType = this.mapGitStatus(status);
      const packagePath = this.getBazelPackage(path);

      changes.push({
        path,
        changeType,
        package: packagePath
      });
    }

    return changes;
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
   * Determine the Bazel package for a given file path
   */
  getBazelPackage(filePath: string): string {
    const parts = filePath.split('/');
    
    // Find the closest BUILD file directory
    for (let i = parts.length - 1; i >= 0; i--) {
      const packagePath = parts.slice(0, i + 1).join('/');
      // In a real implementation, you'd check if BUILD file exists
      // For now, assume each directory is a potential package
      if (i === 0 || this.hasBuildFile(packagePath)) {
        return packagePath;
      }
    }
    
    return parts[0] || '.';
  }

  /**
   * Check if a directory contains a BUILD file (stub implementation)
   */
  private hasBuildFile(packagePath: string): boolean {
    // TODO: Implement actual BUILD file detection
    // This would check for BUILD, BUILD.bazel files
    return true;
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