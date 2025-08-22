import { exec } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { logger } from '../utils/logger';

const execAsync = promisify(exec);

export interface BazelTarget {
  label: string;
  package: string;
  name: string;
  rule: string;
}

export interface DependencyEdge {
  from: string;
  to: string;
  fromPackage: string;
  toPackage: string;
}

export interface DependencyGraph {
  nodes: Set<string>;
  edges: DependencyEdge[];
  packageDependencies: Map<string, Set<string>>; // package -> packages it depends on
  packageDependents: Map<string, Set<string>>;   // package -> packages that depend on it
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
   * Build comprehensive dependency graph using cquery for target scope
   */
  async buildDependencyGraph(targetScope: string, bazelOptions?: { bazelBinary?: string; startupOpts?: string; commandOpts?: string }): Promise<DependencyGraph> {
    let tempFile: string | null = null;
    
    try {
      // Create temporary file for large output
      tempFile = join(tmpdir(), `bazel-cquery-${Date.now()}-${Math.random().toString(36).substr(2, 9)}.txt`);
      
      // Build the bazel cquery command
      let cqueryCommand = `cd ${this.repoRoot}`;
      
      // Use specified bazel binary or default to 'bazel'
      const bazelBinary = bazelOptions?.bazelBinary || 'bazel';
      
      // Add startup options if provided
      if (bazelOptions?.startupOpts) {
        cqueryCommand += ` && ${bazelBinary} ${bazelOptions.startupOpts} cquery`;
      } else {
        cqueryCommand += ` && ${bazelBinary} cquery`;
      }
      
      // Add standard options
      cqueryCommand += ` --notool_deps --output=graph --nograph:factored`;
      
      // Add command options if provided (these are bazel command flags, not query syntax)
      if (bazelOptions?.commandOpts) {
        cqueryCommand += ` ${bazelOptions.commandOpts}`;
      }
      
      // Add the query and output redirection (targetScope should not contain options)
      cqueryCommand += ` "deps(${targetScope})" > "${tempFile}"`;
      
      logger.info(`Executing bazel cquery command: ${cqueryCommand}`);
      
      // Execute command writing to file (no stdout buffer limit)
      await execAsync(cqueryCommand, { timeout: 300000 });
      
      // Read the result from file
      const stdout = await fs.readFile(tempFile, 'utf8');
      
      return this.parseDependencyGraph(stdout);
    } catch (error) {
      logger.error(`Failed to build dependency graph for ${targetScope}:`, error);
      return {
        nodes: new Set(),
        edges: [],
        packageDependencies: new Map(),
        packageDependents: new Map()
      };
    } finally {
      // Clean up temporary file
      if (tempFile) {
        try {
          await fs.unlink(tempFile);
        } catch (cleanupError) {
          logger.warn(`Failed to clean up temporary file ${tempFile}:`, cleanupError);
        }
      }
    }
  }

  /**
   * Parse cquery graph output into structured dependency graph
   */
  private parseDependencyGraph(graphOutput: string): DependencyGraph {
    const nodes = new Set<string>();
    const edges: DependencyEdge[] = [];
    const packageDependencies = new Map<string, Set<string>>();
    const packageDependents = new Map<string, Set<string>>();
    
    const lines = graphOutput.trim().split('\n');
    let nodeCount = 0;
    let edgeCount = 0;
    
    logger.info(`Parsing dependency graph with ${lines.length} lines`);
    
    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine || trimmedLine.startsWith('digraph') || trimmedLine === '}' || trimmedLine.startsWith('node [')) {
        continue;
      }
      
      // Parse node declarations: "//path/to/package:target (hash)"
      // Handle both formats: with hash and with null
      const nodeMatch = trimmedLine.match(/^"([^"]+) \([^)]*\)"$/);
      if (nodeMatch) {
        const target = nodeMatch[1];
        nodes.add(target);
        nodeCount++;
        continue;
      }
      
      // Parse edge declarations: "from (hash)" -> "to (hash)" 
      const edgeMatch = trimmedLine.match(/^"([^"]+) \([^)]*\)" -> "([^"]+) \([^)]*\)"$/);
      if (edgeMatch) {
        const from = edgeMatch[1];
        const to = edgeMatch[2];
        
        const fromPackage = this.extractPackageFromLabel(from);
        const toPackage = this.extractPackageFromLabel(to);
        
        nodes.add(from);
        nodes.add(to);
        
        edges.push({
          from,
          to,
          fromPackage,
          toPackage
        });
        edgeCount++;
        
        // Build package-level dependency maps
        if (fromPackage !== toPackage) {
          // fromPackage depends on toPackage
          if (!packageDependencies.has(fromPackage)) {
            packageDependencies.set(fromPackage, new Set());
          }
          packageDependencies.get(fromPackage)!.add(toPackage);
          
          // toPackage is depended on by fromPackage
          if (!packageDependents.has(toPackage)) {
            packageDependents.set(toPackage, new Set());
          }
          packageDependents.get(toPackage)!.add(fromPackage);
        }
      }
    }
    
    const allPackages = new Set<string>();
    nodes.forEach(node => {
      const pkg = this.extractPackageFromLabel(node);
      if (pkg) allPackages.add(pkg);
    });
    
    logger.info(`Parsed ${nodeCount} node declarations, ${edgeCount} edge declarations`);
    logger.info(`Built dependency graph with ${nodes.size} targets, ${edges.length} edges, ${allPackages.size} packages`);
    
    // Debug: log first few lines that didn't match to see the format
    if (nodeCount === 0 && edgeCount === 0) {
      logger.warn('No nodes or edges parsed! Debugging first 10 non-empty lines:');
      const nonEmptyLines = lines.filter(line => {
        const trimmed = line.trim();
        return trimmed && !trimmed.startsWith('digraph') && trimmed !== '}' && !trimmed.startsWith('node [');
      }).slice(0, 10);
      
      for (const debugLine of nonEmptyLines) {
        logger.warn(`  Line: "${debugLine}"`);
        const nodeTest = debugLine.match(/^"([^"]+) \([^)]*\)"$/);
        const edgeTest = debugLine.match(/^"([^"]+) \([^)]*\)" -> "([^"]+) \([^)]*\)"$/);
        logger.warn(`    Node match: ${!!nodeTest}, Edge match: ${!!edgeTest}`);
      }
    }
    
    logger.info(`Sample packages: ${Array.from(allPackages).slice(0, 10).join(', ')}${allPackages.size > 10 ? ` (and ${allPackages.size - 10} more)` : ''}`);
    
    return {
      nodes,
      edges,
      packageDependencies,
      packageDependents
    };
  }

  /**
   * Get all packages that transitively depend on changed packages using pre-built graph
   */
  getTransitiveDependentsFromGraph(
    changedPackages: string[], 
    dependencyGraph: DependencyGraph,
    maxDepth = 3
  ): Map<string, Set<string>> {
    const result = new Map<string, Set<string>>();
    
    // Initialize result map
    for (const changedPkg of changedPackages) {
      result.set(changedPkg, new Set());
    }
    
    // For each changed package, find its transitive dependents
    for (const changedPkg of changedPackages) {
      const visited = new Set<string>();
      const queue: Array<{pkg: string; depth: number}> = [{pkg: changedPkg, depth: 0}];
      
      while (queue.length > 0) {
        const {pkg, depth} = queue.shift()!;
        
        if (visited.has(pkg) || depth >= maxDepth) {
          continue;
        }
        visited.add(pkg);
        
        const dependents = dependencyGraph.packageDependents.get(pkg) || new Set();
        for (const dependent of dependents) {
          if (dependent !== changedPkg) {
            result.get(changedPkg)!.add(dependent);
            queue.push({pkg: dependent, depth: depth + 1});
          }
        }
      }
    }
    
    return result;
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