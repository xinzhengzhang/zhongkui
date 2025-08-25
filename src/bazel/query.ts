import { exec } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import { join, dirname } from 'path';
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

  // Cache for file package mappings to avoid repeated queries
  private filePackageCache = new Map<string, string>();

  /**
   * Find which package a file belongs to by finding the nearest BUILD file
   * This method avoids expensive bazel query calls by using directory traversal
   */
  async getFilePackage(filePath: string): Promise<string> {
    // Check cache first
    if (this.filePackageCache.has(filePath)) {
      return this.filePackageCache.get(filePath)!;
    }

    // Use BUILD file search directly as it's more efficient
    const packagePath = await this.findNearestBuildFile(filePath);
    
    // Cache the result
    this.filePackageCache.set(filePath, packagePath);
    
    return packagePath;
  }

  /**
   * Batch query multiple files to find their packages efficiently
   * Only use this when you need bazel query accuracy for multiple files
   */
  async getFilePackagesBatch(filePaths: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const uncachedFiles: string[] = [];
    
    // Check cache first
    for (const filePath of filePaths) {
      if (this.filePackageCache.has(filePath)) {
        result.set(filePath, this.filePackageCache.get(filePath)!);
      } else {
        uncachedFiles.push(filePath);
      }
    }
    
    // If all files are cached, return early
    if (uncachedFiles.length === 0) {
      return result;
    }
    
    // For uncached files, use BUILD file search which is more efficient
    for (const filePath of uncachedFiles) {
      const packagePath = await this.findNearestBuildFile(filePath);
      result.set(filePath, packagePath);
      this.filePackageCache.set(filePath, packagePath);
    }
    
    return result;
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
   * Supports multiple target formats:
   * 1. Full labels like "//path/to/package:target"
   * 2. Short labels like ":target" (relative to current package)
   * 3. Legacy external targets like "@external_repo//path:target"
   * 4. New Bazel 6+ external targets like "@@external_repo~//path:target"
   */
  async mapActionToPackage(actionTarget: string): Promise<string> {
    // Handle new Bazel 6+ external repo format first
    if (actionTarget.startsWith('@@')) {
      return this.extractPackageFromLabel(actionTarget);
    }
    
    // Handle internal repo format
    if (actionTarget.startsWith('//')) {
      return this.extractPackageFromLabel(actionTarget);
    }
    
    // Handle legacy external repo format
    if (actionTarget.startsWith('@')) {
      return this.extractPackageFromLabel(actionTarget);
    }

    // Use bazel query for complex cases (like relative targets)
    return this.getTargetPackage(actionTarget);
  }

  /**
   * Build comprehensive dependency graph using cquery for target scope with caching support
   */
  async buildDependencyGraph(targetScope: string, bazelOptions?: { bazelBinary?: string; startupOpts?: string; commandOpts?: string; cacheMode?: 'force' | 'auto' }): Promise<DependencyGraph> {
    // Generate cache key based on target scope and bazel options
    const cacheKey = this.generateGraphCacheKey(targetScope, bazelOptions);
    const cacheDir = join(this.repoRoot, '.zhongkui');
    const cacheFilePath = join(cacheDir, `dependency-graph-${cacheKey}.json`);
    
    // Check for cached dependency graph
    const cacheMode = bazelOptions?.cacheMode || 'auto';
    if (cacheMode === 'auto') {
      try {
        const cachedGraph = await this.loadGraphFromCache(cacheFilePath);
        if (cachedGraph) {
          logger.info(`Using cached dependency graph from: ${cacheFilePath}`);
          return cachedGraph;
        }
      } catch (error) {
        logger.debug('No valid cache found, proceeding with fresh cquery');
      }
    } else {
      logger.info('Cache mode is "force", skipping cache lookup');
    }

    let tempFile: string | null = null;
    
    try {
      // Create temporary file for large output
      tempFile = join(tmpdir(), `bazel-cquery-${Date.now()}-${Math.random().toString(36).substr(2, 9)}.txt`);
      
      // Build the bazel cquery command
      let cqueryCommand = `cd ${this.repoRoot}`;
      
      // Use specified bazel binary or default to 'bazel'
      const bazelBinary = bazelOptions?.bazelBinary || 'bazel';
      
      // Debug: 显示接收到的bazel选项
      logger.info(`\n=== BAZEL QUERY OPTIONS ===`);
      logger.info(`bazelBinary: "${bazelBinary}"`);
      logger.info(`startupOpts: "${bazelOptions?.startupOpts || ''}"`);
      logger.info(`commandOpts: "${bazelOptions?.commandOpts || ''}"`);
      logger.info(`===========================\n`);
      
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
      
      // Display the command with colors (import colors from index.ts or define locally)
      const colors = {
        reset: '\x1b[0m',
        bright: '\x1b[1m',
        green: '\x1b[32m',
        blue: '\x1b[34m',
        yellow: '\x1b[33m',
        cyan: '\x1b[36m'
      };
      
      console.log(`\n${colors.bright}${colors.cyan}🔍 Executing dependency analysis:${colors.reset}`);
      console.log(`${colors.bright}${colors.blue}   ${cqueryCommand.replace(`cd ${this.repoRoot} && `, '')}${colors.reset}\n`);
      
      logger.info(`Executing bazel cquery command: ${cqueryCommand}`);
      
      // Execute command writing to file (no stdout buffer limit)
      await execAsync(cqueryCommand, { timeout: 300000 });
      
      // Read the result from file
      const stdout = await fs.readFile(tempFile, 'utf8');
      
      // Parse the dependency graph
      const dependencyGraph = this.parseDependencyGraph(stdout);
      
      // Save to cache (only if parsing was successful and has data)
      if (dependencyGraph.nodes.size > 0 && cacheMode === 'auto') {
        try {
          await this.saveGraphToCache(cacheFilePath, dependencyGraph);
          logger.info(`Cached dependency graph to: ${cacheFilePath}`);
        } catch (error) {
          logger.warn('Failed to save dependency graph to cache:', error);
        }
      }
      
      return dependencyGraph;
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
   * Supports multiple formats:
   * - //path/to/package:target -> path/to/package
   * - @external_repo//path:target -> @external_repo//path (legacy format)
   * - @@external_repo~//path:target -> @external_repo//path (Bazel 6-7 format)
   * - @@module~~ext~repo//path:target -> @module~~ext~repo//path (Bazel 6-7 Bzlmod format)
   * - @@external_repo+//path:target -> @external_repo//path (Bazel 8+ format)
   * - @@module++ext+repo//path:target -> @module++ext+repo//path (Bazel 8+ Bzlmod format)
   */
  private extractPackageFromLabel(label: string): string {
    // Handle new Bazel 6+ external repo format: @@repo~//package:target
    if (label.startsWith('@@')) {
      // Handle Bzlmod format:
      // Bazel 6-7: @@module~~extension~repo//package or @@repo~//package
      // Bazel 8+:   @@module++extension+repo//package or @@repo+//package
      const match = label.match(/^@@([^~+]+)(?:[~+].*)?\/\/([^:]*)/);
      if (match) {
        const [, repoName, packagePath] = match;
        const result = `@${repoName}//${packagePath || ''}`;
        logger.debug(`Converted Bazel 6+ external repo label: ${label} -> ${result}`);
        return result;
      }
      // Fallback if pattern doesn't match
      logger.warn(`Failed to parse Bazel 6+ external repo label: ${label}`);
      return label;
    }
    
    // Handle legacy external repo format: @repo//package:target
    if (label.startsWith('@')) {
      const match = label.match(/^@([^/]+)\/\/([^:]*)/);
      if (match) {
        const [, repoName, packagePath] = match;
        const result = `@${repoName}//${packagePath || ''}`;
        logger.debug(`Parsed legacy external repo label: ${label} -> ${result}`);
        return result;
      }
      // If no // found, return the whole external repo reference
      logger.debug(`External repo label without package: ${label}`);
      return label;
    }
    
    // Handle internal repo format: //package:target
    if (label.startsWith('//')) {
      const colonIndex = label.indexOf(':');
      const result = colonIndex > 0 ? label.slice(2, colonIndex) : label.slice(2);
      logger.debug(`Parsed internal repo label: ${label} -> ${result}`);
      return result;
    }
    
    // Default case
    logger.debug(`Unknown label format: ${label}`);
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
   * Find the nearest BUILD file for a given file path, considering sub Bazel modules
   */
  private async findNearestBuildFile(filePath: string): Promise<string> {
    const parts = filePath.split('/');
    let moduleRoot = this.repoRoot;
    
    // First, find the Bazel module root for this file
    for (let i = parts.length - 1; i >= 0; i--) {
      const currentPath = parts.slice(0, i + 1).join('/');
      const fullPath = `${this.repoRoot}/${currentPath}`;
      
      // Check if this directory contains WORKSPACE, WORKSPACE.bzl, or MODULE.bazel
      try {
        const workspacePath = `${fullPath}/WORKSPACE`;
        const workspaceBzlPath = `${fullPath}/WORKSPACE.bzl`;
        const moduleBazelPath = `${fullPath}/MODULE.bazel`;
        
        await execAsync(`test -f "${workspacePath}" || test -f "${workspaceBzlPath}" || test -f "${moduleBazelPath}"`);
        
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
          const buildFilePath = `${moduleRoot}/${packagePath}/BUILD`;
          const buildBazelPath = `${moduleRoot}/${packagePath}/BUILD.bazel`;
          
          try {
            await execAsync(`test -f "${buildFilePath}" || test -f "${buildBazelPath}"`);
            return packagePath;
          } catch {
            // Continue searching parent directories
          }
        }
        
        // If no BUILD file found in this module, return root package relative to module
        return '.';
      } catch {
        // No Bazel module marker found, continue searching
      }
    }
    
    // Fallback: search in the original repo root without module consideration
    for (let i = parts.length - 1; i >= 0; i--) {
      const packagePath = parts.slice(0, i + 1).join('/');
      const buildFilePath = `${this.repoRoot}/${packagePath}/BUILD`;
      const buildBazelPath = `${this.repoRoot}/${packagePath}/BUILD.bazel`;
      
      try {
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

  /**
   * Generate cache key for dependency graph based on target scope and options
   */
  private generateGraphCacheKey(targetScope: string, bazelOptions?: { bazelBinary?: string; startupOpts?: string; commandOpts?: string }): string {
    const data = {
      // 添加算法版本以确保缓存失效当算法改变时
      algorithmVersion: 'v2.1-external-repo-support',
      targetScope,
      bazelBinary: bazelOptions?.bazelBinary || 'bazel',
      startupOpts: bazelOptions?.startupOpts || '',
      commandOpts: bazelOptions?.commandOpts || ''
    };
    const { createHash } = require('crypto');
    const hash = createHash('sha256').update(JSON.stringify(data)).digest('hex');
    return hash.substring(0, 16);
  }

  /**
   * Load dependency graph from cache file
   */
  private async loadGraphFromCache(cacheFilePath: string): Promise<DependencyGraph | null> {
    try {
      const cacheData = await fs.readFile(cacheFilePath, 'utf8');
      const cached = JSON.parse(cacheData);
      
      // Validate cache format and version
      if (cached.version !== '1.0' || !cached.graph) {
        logger.debug('Cache format mismatch, ignoring cache');
        return null;
      }
      
      // Reconstruct the dependency graph from serialized data
      const nodes = new Set<string>(cached.graph.nodes);
      const edges = cached.graph.edges as DependencyEdge[];
      const packageDependencies = new Map<string, Set<string>>();
      const packageDependents = new Map<string, Set<string>>();
      
      // Reconstruct the Maps from serialized objects
      for (const [pkg, deps] of Object.entries(cached.graph.packageDependencies as Record<string, string[]>)) {
        packageDependencies.set(pkg, new Set(deps));
      }
      
      for (const [pkg, deps] of Object.entries(cached.graph.packageDependents as Record<string, string[]>)) {
        packageDependents.set(pkg, new Set(deps));
      }
      
      return {
        nodes,
        edges,
        packageDependencies,
        packageDependents
      };
    } catch (error) {
      logger.debug(`Failed to load cache from ${cacheFilePath}:`, error);
      return null;
    }
  }

  /**
   * Save dependency graph to cache file
   */
  private async saveGraphToCache(cacheFilePath: string, graph: DependencyGraph): Promise<void> {
    try {
      // Ensure cache directory exists
      await fs.mkdir(dirname(cacheFilePath), { recursive: true });
      
      // Convert Maps to serializable objects
      const packageDependenciesObj: Record<string, string[]> = {};
      for (const [pkg, deps] of graph.packageDependencies) {
        packageDependenciesObj[pkg] = Array.from(deps);
      }
      
      const packageDependentsObj: Record<string, string[]> = {};
      for (const [pkg, deps] of graph.packageDependents) {
        packageDependentsObj[pkg] = Array.from(deps);
      }
      
      const cacheData = {
        version: '1.0',
        timestamp: new Date().toISOString(),
        graph: {
          nodes: Array.from(graph.nodes),
          edges: graph.edges,
          packageDependencies: packageDependenciesObj,
          packageDependents: packageDependentsObj
        }
      };
      
      await fs.writeFile(cacheFilePath, JSON.stringify(cacheData, null, 2));
    } catch (error) {
      throw new Error(`Failed to save cache to ${cacheFilePath}: ${error}`);
    }
  }
}