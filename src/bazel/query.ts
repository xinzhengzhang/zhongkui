import { exec } from 'child_process';
import { promisify } from 'util';
import { logger } from '../utils/logger';

const execAsync = promisify(exec);

export interface BazelTarget {
  label: string;
  package: string;
  name: string;
  rule: string;
}

export interface PackageDependency {
  package: string;
  dependencies: string[];
  dependents: string[];
}

/**
 * Provides Bazel query functionality for target and dependency analysis
 */
export class BazelQuery {
  private repoRoot: string;

  constructor(repoRoot: string) {
    this.repoRoot = repoRoot;
  }

  /**
   * Get the package that owns a specific target
   */
  async getTargetPackage(target: string): Promise<string> {
    try {
      const { stdout } = await execAsync(
        `cd ${this.repoRoot} && bazel query --output=package "${target}"`,
        { timeout: 30000 }
      );
      return stdout.trim();
    } catch (error) {
      logger.warn(`Failed to get package for target ${target}:`, error);
      // Fallback to extracting from target label
      return this.extractPackageFromLabel(target);
    }
  }

  /**
   * Get all targets in a specific package
   */
  async getPackageTargets(packagePath: string): Promise<BazelTarget[]> {
    try {
      const query = `//${packagePath}:*`;
      const { stdout } = await execAsync(
        `cd ${this.repoRoot} && bazel query --output=label_kind "${query}"`,
        { timeout: 60000 }
      );

      return this.parseLabelKindOutput(stdout);
    } catch (error) {
      logger.error(`Failed to get targets for package ${packagePath}:`, error);
      return [];
    }
  }

  /**
   * Find which package a file belongs to by finding the nearest BUILD file
   */
  async getFilePackage(filePath: string): Promise<string> {
    try {
      // Use bazel query to find the package containing this file
      const { stdout } = await execAsync(
        `cd ${this.repoRoot} && bazel query --output=package "rdeps(//..., ${filePath}, 1)"`,
        { timeout: 30000 }
      );
      
      const packages = stdout.trim().split('\n').filter(p => p);
      if (packages.length > 0) {
        // Return the most specific (longest) package path
        return packages.reduce((longest, current) => 
          current.length > longest.length ? current : longest
        );
      }
    } catch (error) {
      logger.warn(`Bazel query failed for file ${filePath}, falling back to BUILD file search:`, error);
    }

    // Fallback: search for BUILD files in directory hierarchy
    return this.findNearestBuildFile(filePath);
  }

  /**
   * Get direct dependencies of a package
   */
  async getPackageDependencies(packagePath: string): Promise<string[]> {
    try {
      const query = `kind(".*", deps(//${packagePath}:*)) except //${packagePath}:*`;
      const { stdout } = await execAsync(
        `cd ${this.repoRoot} && bazel query --output=package "${query}"`,
        { timeout: 60000 }
      );

      return [...new Set(stdout.trim().split('\n').filter(p => p))];
    } catch (error) {
      logger.error(`Failed to get dependencies for package ${packagePath}:`, error);
      return [];
    }
  }

  /**
   * Get packages that depend on the given package within target scope
   */
  async getPackageDependents(packagePath: string, targetScope?: string): Promise<string[]> {
    try {
      let query: string;
      if (targetScope) {
        // Limit dependents to those within the target scope
        query = `rdeps(${targetScope}, //${packagePath}:*, 1)`;
      } else {
        query = `rdeps(//..., //${packagePath}:*, 1)`;
      }
      
      const { stdout } = await execAsync(
        `cd ${this.repoRoot} && bazel query --output=package "${query}"`,
        { timeout: 60000 }
      );

      return [...new Set(stdout.trim().split('\n').filter(p => p && p !== packagePath))];
    } catch (error) {
      logger.error(`Failed to get dependents for package ${packagePath}:`, error);
      return [];
    }
  }

  /**
   * Find all packages affected by changes in a given package within target scope
   */
  async getTransitiveDependents(packagePath: string, targetScope?: string, maxDepth = 3): Promise<string[]> {
    try {
      let query: string;
      if (targetScope) {
        // Limit transitive dependents to those within the target scope
        query = `rdeps(${targetScope}, //${packagePath}:*, ${maxDepth})`;
      } else {
        query = `rdeps(//..., //${packagePath}:*, ${maxDepth})`;
      }
      
      const { stdout } = await execAsync(
        `cd ${this.repoRoot} && bazel query --output=package "${query}"`,
        { timeout: 120000 }
      );

      return [...new Set(stdout.trim().split('\n').filter(p => p && p !== packagePath))];
    } catch (error) {
      logger.error(`Failed to get transitive dependents for package ${packagePath}:`, error);
      return [];
    }
  }

  /**
   * Map an action target to its owning package
   */
  async mapActionToPackage(actionTarget: string): Promise<string> {
    // Handle different target formats:
    // 1. Full labels like "//path/to/package:target"
    // 2. Short labels like ":target" (relative to current package)
    // 3. External targets like "@external_repo//path:target"
    
    if (actionTarget.startsWith('//')) {
      return this.extractPackageFromLabel(actionTarget);
    }
    
    if (actionTarget.startsWith('@')) {
      // External dependency - extract package after the //
      const match = actionTarget.match(/@[^/]+\/\/([^:]+)/);
      return match ? match[1] : actionTarget;
    }

    // Use bazel query for complex cases
    return this.getTargetPackage(actionTarget);
  }

  /**
   * Get build configuration information for a target
   */
  async getTargetConfiguration(target: string): Promise<Record<string, string>> {
    try {
      const { stdout } = await execAsync(
        `cd ${this.repoRoot} && bazel query --output=build "${target}"`,
        { timeout: 30000 }
      );

      return this.parseBuildOutput(stdout);
    } catch (error) {
      logger.warn(`Failed to get configuration for target ${target}:`, error);
      return {};
    }
  }

  /**
   * Extract package path from a Bazel label
   */
  private extractPackageFromLabel(label: string): string {
    if (label.startsWith('//')) {
      const colonIndex = label.indexOf(':');
      return colonIndex > 0 ? label.slice(2, colonIndex) : label.slice(2);
    }
    return label;
  }

  /**
   * Parse bazel query label_kind output
   */
  private parseLabelKindOutput(output: string): BazelTarget[] {
    const lines = output.trim().split('\n').filter(line => line);
    const targets: BazelTarget[] = [];

    for (const line of lines) {
      const match = line.match(/^(\w+)\s+rule\s+(.+)$/);
      if (match) {
        const [, rule, label] = match;
        const packagePath = this.extractPackageFromLabel(label);
        const name = label.split(':').pop() || '';
        
        targets.push({
          label,
          package: packagePath,
          name,
          rule
        });
      }
    }

    return targets;
  }

  /**
   * Find the nearest BUILD file for a given file path
   */
  private async findNearestBuildFile(filePath: string): Promise<string> {
    const parts = filePath.split('/');
    
    for (let i = parts.length - 1; i >= 0; i--) {
      const packagePath = parts.slice(0, i + 1).join('/');
      const buildFilePath = `${this.repoRoot}/${packagePath}/BUILD`;
      const buildBazelPath = `${this.repoRoot}/${packagePath}/BUILD.bazel`;
      
      try {
        // Check if BUILD file exists
        await execAsync(`test -f "${buildFilePath}" || test -f "${buildBazelPath}"`);
        return packagePath;
      } catch {
        // Continue searching parent directories
      }
    }
    
    return '.'; // Root package
  }

  /**
   * Parse bazel query build output to extract configuration
   */
  private parseBuildOutput(output: string): Record<string, string> {
    const config: Record<string, string> = {};
    
    // Extract key attributes from BUILD rule definition
    const lines = output.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.includes('=')) {
        const [key, ...valueParts] = trimmed.split('=');
        const value = valueParts.join('=').trim().replace(/[",\[\]]/g, '');
        config[key.trim()] = value;
      }
    }
    
    return config;
  }
}