import { exec } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import { join } from 'path';
import { FileChange } from '../types';
import { logger } from '../utils/logger';

const execAsync = promisify(exec);

export interface AdditionalRepo {
  path: string;
  repoName: string | null;
}

/**
 * Analyzes file changes to determine which Bazel packages are impacted
 */
export class DiffAnalyzer {
  private repoRoot: string;
  private additionalRepos: AdditionalRepo[];
  
  constructor(repoRoot: string, additionalRepos: AdditionalRepo[] = []) {
    this.repoRoot = repoRoot;
    this.additionalRepos = additionalRepos;
  }

  /**
   * Analyze file changes in the main repository and additional independent git repos
   */
  async analyzeChanges(repoRoot: string, baseBranch = 'origin/master'): Promise<FileChange[]> {
    logger.info(`Analyzing file changes in ${repoRoot}`);
    
    // Start with main repository
    const reposToAnalyze = [
      { path: repoRoot, repoName: null },
      ...this.additionalRepos
    ];
    const allChanges: FileChange[] = [];
    
    for (const repo of reposToAnalyze) {
      try {
        logger.info(`Scanning repository: ${repo.path} (repo name: ${repo.repoName || 'main'})`);
        
        // Check if this path contains a git repository
        const hasGitRepo = await this.hasGitRepository(repo.path);
        if (!hasGitRepo) {
          logger.warn(`Path ${repo.path} is not a git repository, skipping`);
          continue;
        }
        
        // Get committed changes between base branch and HEAD
        const committedCommand = `cd "${repo.path}" && git diff --name-status ${baseBranch}...HEAD`;
        logger.info(`Executing git diff command for committed changes: ${committedCommand}`);
        
        // Get uncommitted changes (both staged and unstaged)  
        const uncommittedCommand = `cd "${repo.path}" && git diff --name-status HEAD`;
        logger.info(`Executing git diff command for uncommitted changes: ${uncommittedCommand}`);
        
        const [committedResult, uncommittedResult] = await Promise.all([
          execAsync(committedCommand).catch((error) => {
            logger.debug(`Committed changes command failed for ${repo.path}:`, error);
            return { stdout: '' };
          }),
          execAsync(uncommittedCommand).catch((error) => {
            logger.debug(`Uncommitted changes command failed for ${repo.path}:`, error);
            return { stdout: '' };
          })
        ]);
        
        const combinedOutput = [committedResult.stdout, uncommittedResult.stdout]
          .filter(output => output.trim())
          .join('\n');
        
        logger.info(`Repository ${repo.path}: git diff output length: ${combinedOutput.length} characters`);
        logger.debug(`Repository ${repo.path}: git diff output:\n${combinedOutput}`);
        
        if (combinedOutput.trim()) {
          const repoChanges = await this.parseGitDiffWithBuildFileMapping(combinedOutput, repo);
          allChanges.push(...repoChanges);
          logger.info(`Repository ${repo.path}: found ${repoChanges.length} changes`);
        } else {
          logger.info(`Repository ${repo.path}: no changes detected`);
        }
      } catch (error) {
        logger.warn(`Failed to analyze changes in repository ${repo.path}:`, error);
        // Continue with other repositories instead of failing entirely
      }
    }
    
    logger.info(`Total changes across all repositories: ${allChanges.length}`);
    return allChanges;
  }

  /**
   * Parse git diff output and find Bazel packages by locating BUILD files
   */
  private async parseGitDiffWithBuildFileMapping(diffOutput: string, repo: AdditionalRepo): Promise<FileChange[]> {
    const lines = diffOutput.trim().split('\n').filter(line => line);
    const changes: FileChange[] = [];

    for (const line of lines) {
      const [status, path] = line.split('\t');
      if (!path) continue;

      const changeType = this.mapGitStatus(status);
      
      // Find the package by looking for the first BUILD file in parent directories
      const packagePath = await this.findPackageByBuildFile(path, repo.path);

      // Determine the final package path with correct repo name
      const finalPackagePath = this.generatePackagePath(packagePath, repo);

      changes.push({
        path: repo.path !== this.repoRoot ? `${repo.path}/${path}` : path,
        changeType,
        package: finalPackagePath
      });
    }

    // Debug: log detected packages
    const packages = [...new Set(changes.map(c => c.package))];
    logger.info(`Repository ${repo.path}: detected ${changes.length} file changes in ${packages.length} packages: ${packages.join(', ')}`);

    return changes;
  }

  /**
   * Generate the correct package path for a repository
   */
  private generatePackagePath(packagePath: string, repo: AdditionalRepo): string {
    // For main repository, return package path as-is
    if (repo.path === this.repoRoot) {
      // Keep root package as "." to avoid confusion with empty string
      return packagePath;
    }

    // For additional repositories, use explicit repo name if provided
    const repoName = repo.repoName || this.getRepoIdentifier(repo.path);
    const normalizedPackagePath = packagePath === '.' ? '' : packagePath;
    return `@${repoName}//${normalizedPackagePath}`;
  }

  /**
   * Find the Bazel package for a file by locating the nearest BUILD file
   * Supports sub-bazel modules by detecting WORKSPACE/MODULE.bazel files
   */
  private async findPackageByBuildFile(filePath: string, repoRoot: string): Promise<string> {
    const parts = filePath.split('/');
    let moduleRoot = repoRoot;
    
    // First, find the Bazel module root for this file
    for (let i = parts.length - 1; i >= 0; i--) {
      const currentPath = parts.slice(0, i + 1).join('/');
      const fullPath = currentPath ? join(repoRoot, currentPath) : repoRoot;
      
      // Check if this directory contains WORKSPACE, WORKSPACE.bzl, or MODULE.bazel
      const workspacePath = join(fullPath, 'WORKSPACE');
      const workspaceBzlPath = join(fullPath, 'WORKSPACE.bzl');
      const moduleBazelPath = join(fullPath, 'MODULE.bazel');
      
      const [wsExists, wsBzlExists, moduleExists] = await Promise.all([
        this.fileExists(workspacePath),
        this.fileExists(workspaceBzlPath),
        this.fileExists(moduleBazelPath)
      ]);
      
      if (wsExists || wsBzlExists || moduleExists) {
        // Found a Bazel module root, update our search base
        moduleRoot = fullPath;
        
        // Recalculate parts relative to this module root
        const relativePath = filePath.startsWith(currentPath + '/') 
          ? filePath.slice(currentPath.length + 1)
          : filePath;
        const relativeParts = relativePath.split('/');
        
        // Now search for BUILD files starting from this module root
        for (let j = relativeParts.length - 1; j >= 0; j--) {
          const packagePath = relativeParts.slice(0, j + 1).join('/');
          const buildPath = join(moduleRoot, packagePath, 'BUILD');
          const buildBazelPath = join(moduleRoot, packagePath, 'BUILD.bazel');
          
          const [buildExists, buildBazelExists] = await Promise.all([
            this.fileExists(buildPath),
            this.fileExists(buildBazelPath)
          ]);
          
          if (buildExists || buildBazelExists) {
            return packagePath || '.';
          }
        }
        
        // If no BUILD file found in this module, return root package relative to module
        return '.';
      }
    }
    
    // Fallback: search in the original repo root without module consideration
    for (let i = parts.length - 1; i >= 0; i--) {
      const dirPath = parts.slice(0, i).join('/');
      const fullDirPath = dirPath ? join(repoRoot, dirPath) : repoRoot;
      
      // Check for BUILD or BUILD.bazel files
      const buildPath = join(fullDirPath, 'BUILD');
      const buildBazelPath = join(fullDirPath, 'BUILD.bazel');
      
      const [buildExists, buildBazelExists] = await Promise.all([
        this.fileExists(buildPath),
        this.fileExists(buildBazelPath)
      ]);
      
      if (buildExists || buildBazelExists) {
        return dirPath || '.';
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
   * Get a repository identifier from its path for external repo labels
   * This should match the repository name used in Bazel configuration
   */
  private getRepoIdentifier(repoPath: string): string {
    // Extract the last directory name as the repo identifier
    const parts = repoPath.replace(/\/$/, '').split('/');
    const dirName = parts[parts.length - 1] || 'external';
    
    logger.debug(`Generating repo identifier for path ${repoPath}: ${dirName}`);
    return dirName;
  }

  /**
   * Get all files that belong to a specific Bazel package
   */
  async getPackageFiles(repoRoot: string, packagePath: string): Promise<string[]> {
    try {
      // Handle external repo package paths
      if (packagePath.startsWith('@')) {
        // For external repos, we can't easily list files without knowing the actual path
        logger.warn(`Cannot list files for external repo package: ${packagePath}`);
        return [];
      }
      
      const { stdout } = await execAsync(`cd ${repoRoot} && find ${packagePath === '.' ? '.' : packagePath} -type f`);
      return stdout.trim().split('\n').filter(line => line);
    } catch (error) {
      logger.error(`Failed to get files for package ${packagePath}:`, error);
      return [];
    }
  }

  /**
   * Set additional repositories to scan for changes
   */
  setAdditionalRepos(additionalRepos: AdditionalRepo[]): void {
    this.additionalRepos = additionalRepos;
  }

  /**
   * Check if a directory contains a git repository
   */
  private async hasGitRepository(repoPath: string): Promise<boolean> {
    try {
      await execAsync(`cd "${repoPath}" && git rev-parse --git-dir`);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get the list of repositories being scanned
   */
  getReposToScan(): AdditionalRepo[] {
    return [
      { path: this.repoRoot, repoName: null },
      ...this.additionalRepos
    ];
  }
}