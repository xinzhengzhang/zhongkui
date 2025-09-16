import { promises as fs } from 'fs';
import { join } from 'path';
import { logger } from './logger';

/**
 * Handles .zhongkuiignore file parsing and package filtering
 * Similar to .gitignore but for ignoring Bazel packages from attribution analysis
 */
export class IgnoreManager {
  private ignorePatterns: string[] = [];
  private ignoreFilePath?: string;

  constructor(repoRoot: string, customIgnoreFilePath?: string) {
    this.ignoreFilePath = customIgnoreFilePath || join(repoRoot, '.zhongkuiignore');
  }

  /**
   * Load ignore patterns from .zhongkuiignore file
   */
  async loadIgnorePatterns(): Promise<void> {
    if (!this.ignoreFilePath) return;

    try {
      const content = await fs.readFile(this.ignoreFilePath, 'utf-8');
      this.ignorePatterns = this.parseIgnoreFile(content);
      
      if (this.ignorePatterns.length > 0) {
        logger.info(`Loaded ${this.ignorePatterns.length} ignore patterns from: ${this.ignoreFilePath}`);
        logger.info(`Ignore patterns: ${this.ignorePatterns.join(', ')}`);
      }
    } catch (error) {
      if ((error as any).code === 'ENOENT') {
        logger.debug(`No .zhongkuiignore file found at: ${this.ignoreFilePath}`);
      } else {
        logger.warn(`Failed to read .zhongkuiignore file at ${this.ignoreFilePath}:`, error);
      }
    }
  }

  /**
   * Parse .zhongkuiignore file content
   * Supports:
   * - Empty lines (ignored)
   * - Comments starting with # (ignored)
   * - Package paths like //genfiles or genfiles
   */
  private parseIgnoreFile(content: string): string[] {
    const lines = content.split('\n');
    const patterns: string[] = [];

    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
      let line = lines[lineNum].trim();

      // Skip empty lines
      if (!line) {
        continue;
      }

      // Skip comments
      if (line.startsWith('#')) {
        continue;
      }

      // Remove inline comments
      const commentIndex = line.indexOf('#');
      if (commentIndex >= 0) {
        line = line.substring(0, commentIndex).trim();
      }

      // Skip if line became empty after removing inline comment
      if (!line) {
        continue;
      }

      // Normalize package path
      const normalizedPattern = this.normalizePackagePath(line);
      patterns.push(normalizedPattern);

      logger.debug(`Parsed ignore pattern from line ${lineNum + 1}: "${line}" -> "${normalizedPattern}"`);
    }

    return patterns;
  }

  /**
   * Normalize package path to consistent format
   * Converts formats like:
   * - "genfiles" -> "genfiles"
   * - "//genfiles" -> "genfiles"
   * - "//path/to/package" -> "path/to/package"
   */
  private normalizePackagePath(pattern: string): string {
    // Remove leading // if present
    if (pattern.startsWith('//')) {
      return pattern.slice(2);
    }
    return pattern;
  }

  /**
   * Check if a package should be ignored based on loaded patterns
   */
  shouldIgnorePackage(packagePath: string): boolean {
    if (this.ignorePatterns.length === 0) {
      return false;
    }

    const normalizedPackage = this.normalizePackagePath(packagePath);
    
    // Check exact matches and wildcard patterns
    for (const pattern of this.ignorePatterns) {
      if (this.matchesPattern(normalizedPackage, pattern)) {
        logger.debug(`Package "${packagePath}" matches ignore pattern "${pattern}"`);
        return true;
      }
    }

    return false;
  }

  /**
   * Check if a package matches an ignore pattern
   * Supports basic glob patterns:
   * - Exact match: genfiles matches genfiles
   * - Prefix match: genfiles/* matches genfiles/something
   * - Suffix match: star/test matches some/path/test
   * - Contains match: star-test-star matches some/test/path
   */
  private matchesPattern(packagePath: string, pattern: string): boolean {
    // Exact match
    if (packagePath === pattern) {
      return true;
    }

    // Handle wildcard patterns
    if (pattern.includes('*')) {
      return this.matchGlobPattern(packagePath, pattern);
    }

    // Prefix match (treat pattern as prefix if it ends with /)
    if (pattern.endsWith('/') && packagePath.startsWith(pattern)) {
      return true;
    }

    return false;
  }

  /**
   * Simple glob pattern matching
   */
  private matchGlobPattern(text: string, pattern: string): boolean {
    // Convert glob pattern to regex
    const escapedPattern = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape special regex chars
      .replace(/\*/g, '.*'); // Convert * to .*

    const regex = new RegExp(`^${escapedPattern}$`);
    return regex.test(text);
  }

  /**
   * Filter file changes by removing ignored packages
   */
  filterFileChanges<T extends { package: string }>(fileChanges: T[]): {
    filtered: T[];
    excluded: T[];
  } {
    if (this.ignorePatterns.length === 0) {
      return { filtered: fileChanges, excluded: [] };
    }

    const filtered: T[] = [];
    const excluded: T[] = [];

    for (const fileChange of fileChanges) {
      if (this.shouldIgnorePackage(fileChange.package)) {
        excluded.push(fileChange);
      } else {
        filtered.push(fileChange);
      }
    }

    if (excluded.length > 0) {
      const excludedPackages = new Set(excluded.map(fc => fc.package));
      logger.info(`Excluded ${excluded.length} file changes from ${excludedPackages.size} ignored packages: ${Array.from(excludedPackages).join(', ')}`);
      logger.info(`Remaining: ${filtered.length} file changes`);
    }

    return { filtered, excluded };
  }

  /**
   * Get list of currently loaded ignore patterns
   */
  getIgnorePatterns(): string[] {
    return [...this.ignorePatterns];
  }

  /**
   * Get the path to the ignore file being used
   */
  getIgnoreFilePath(): string | undefined {
    return this.ignoreFilePath;
  }
}