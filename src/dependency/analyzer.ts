import { BazelAction, FileChange, BuildAnalysis, PackageHotspot, PackageDependencyGraph, PackageNode } from '../types';
import { BazelQuery, DependencyGraph } from '../bazel/query';
import { logger } from '../utils/logger';

/**
 * Analyzes dependencies between actions and file changes to determine build impact
 * Uses Bazel query to accurately map actions to packages and understand dependency relationships
 */
export class DependencyAnalyzer {
  private bazelQuery: BazelQuery;
  private packageCache = new Map<string, string>(); // Cache for target -> package mapping
  private dependencyGraph?: DependencyGraph; // Cached dependency graph

  constructor(repoRoot: string) {
    this.bazelQuery = new BazelQuery(repoRoot);
  }

  /**
   * Analyze the relationship between file changes and action executions
   */
  async analyze(actions: BazelAction[], fileChanges: FileChange[], targetScope?: string, config?: string): Promise<BuildAnalysis> {
    logger.info(`Analyzing dependencies for ${actions.length} actions and ${fileChanges.length} file changes${targetScope ? ` within scope: ${targetScope}` : ''}`);

    // Step 1: Build comprehensive dependency graph using cquery (one-time cost)
    if (!this.dependencyGraph && targetScope) {
      logger.info('Building dependency graph using bazel cquery...');
      this.dependencyGraph = await this.bazelQuery.buildDependencyGraph(targetScope, { bazelBinary: config });
    }

    // Step 2: Resolve packages for all actions using Bazel query
    const actionsWithPackages = await this.resolveActionPackages(actions);
    
    // Step 3: Filter actions based on target scope AFTER we have full dependency graph
    const scopedActions = targetScope ? this.filterActionsByScope(actionsWithPackages, targetScope) : actionsWithPackages;
    logger.info(`Filtered to ${scopedActions.length} actions within target scope`);
    
    // Step 4: Build package dependency graph (lightweight, using cached data)
    const packageDependencyGraph = await this.buildPackageDependencyGraph(scopedActions, fileChanges, targetScope);
    
    // Step 5: Find impacted actions using pre-built dependency graph (no additional queries!)
    const impactedActions = await this.findImpactedActions(scopedActions, fileChanges, packageDependencyGraph, targetScope);
    
    // Step 6: Calculate accurate package hotspots with proper attribution
    const packageHotspots = await this.calculatePackageHotspots(impactedActions, fileChanges, packageDependencyGraph, targetScope);

    return {
      invocationId: undefined,
      fileChanges,
      impactedActions,
      packageHotspots,
      packageDependencyGraph
    };
  }

  /**
   * Filter actions to include target scope and its dependencies
   */
  private filterActionsByScope(actions: BazelAction[], targetScope: string): BazelAction[] {
    if (!this.dependencyGraph) {
      // Fallback to simple pattern matching if no dependency graph
      const regex = this.convertPatternToRegex(targetScope);
      return actions.filter(action => regex.test(action.target));
    }
    
    // Include actions that are:
    // 1. Directly matching the target scope
    // 2. Dependencies of targets in the scope (found in dependency graph)
    const scopedTargets = new Set<string>();
    
    // Add all nodes from dependency graph (these are all dependencies of the target scope)
    for (const target of this.dependencyGraph.nodes) {
      scopedTargets.add(target);
    }
    
    const filteredActions = actions.filter(action => scopedTargets.has(action.target));
    
    logger.info(`Target scope includes ${scopedTargets.size} targets from dependency graph`);
    logger.info(`Sample included targets: ${Array.from(scopedTargets).slice(0, 5).join(', ')}`);
    
    return filteredActions;
  }

  /**
   * Convert Bazel target pattern to regex
   */
  private convertPatternToRegex(pattern: string): RegExp {
    let regexPattern = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\\\.\\\.\\\./g, '.*')
      .replace(/\\\*/g, '[^:]*');
    
    return new RegExp(`^${regexPattern}$`);
  }

  /**
   * Resolve the owning package for each action using Bazel query
   */
  private async resolveActionPackages(actions: BazelAction[]): Promise<BazelAction[]> {
    logger.info('Resolving package ownership for actions using Bazel query');
    
    const resolvedActions: BazelAction[] = [];
    
    for (const action of actions) {
      try {
        let packagePath = this.packageCache.get(action.target);
        
        if (!packagePath) {
          packagePath = await this.bazelQuery.mapActionToPackage(action.target);
          this.packageCache.set(action.target, packagePath);
        }
        
        resolvedActions.push({
          ...action,
          package: packagePath
        });
      } catch (error) {
        logger.warn(`Failed to resolve package for action ${action.target}, using fallback:`, error);
        resolvedActions.push({
          ...action,
          package: this.extractPackageFromTarget(action.target)
        });
      }
    }
    
    return resolvedActions;
  }

  /**
   * Build comprehensive package dependency graph within target scope
   */
  private async buildPackageDependencyGraph(
    actions: BazelAction[], 
    fileChanges: FileChange[],
    targetScope?: string
  ): Promise<PackageDependencyGraph> {
    logger.info(`Building package dependency graph${targetScope ? ` within scope: ${targetScope}` : ''}`);
    
    const packageNodes = new Map<string, PackageNode>();
    
    // Get all unique packages from actions and file changes
    const allPackages = new Set<string>();
    actions.forEach(action => {
      if (action.package) allPackages.add(action.package);
    });
    fileChanges.forEach(change => allPackages.add(change.package));
    
    // Build basic nodes for each package (no need for expensive Bazel queries here)
    for (const packagePath of allPackages) {
      const packageActions = actions.filter(a => a.package === packagePath);
      
      packageNodes.set(packagePath, {
        packagePath,
        actions: packageActions,
        impactWeight: 1.0
      });
    }
    
    return { packages: packageNodes };
  }

  /**
   * Find actions impacted by file changes using pre-built dependency graph (zero additional queries!)
   */
  private async findImpactedActions(
    actions: BazelAction[], 
    fileChanges: FileChange[],
    dependencyGraph: PackageDependencyGraph,
    targetScope?: string
  ): Promise<BazelAction[]> {
    const changedPackages = new Set(fileChanges.map(fc => fc.package));
    const impactedActions: BazelAction[] = [];
    const processedActions = new Set<string>();
    
    // Debug: log package information
    const actionPackages = [...new Set(actions.map(a => a.package).filter(Boolean))];
    logger.info(`Changed packages from git diff: ${Array.from(changedPackages).join(', ')}`);
    logger.info(`Action packages from profile: ${actionPackages.join(', ')}`);
    
    // Check for overlap
    const overlappingPackages = actionPackages.filter(pkg => changedPackages.has(pkg!));
    logger.info(`Overlapping packages: ${overlappingPackages.join(', ')}`);
    
    // Direct impact: actions in changed packages
    for (const action of actions) {
      if (action.package && changedPackages.has(action.package)) {
        impactedActions.push(action);
        processedActions.add(action.id);
        logger.info(`Direct impact: action ${action.target} in changed package ${action.package}`);
      }
    }
    
    // Transitive impact: use pre-built dependency graph (no queries needed!)
    if (this.dependencyGraph) {
      const changedPackagesList = Array.from(changedPackages);
      logger.info(`Looking for transitive dependents of changed packages: ${changedPackagesList.join(', ')}`);
      
      const bulkDependentsMap = this.bazelQuery.getTransitiveDependentsFromGraph(
        changedPackagesList, 
        this.dependencyGraph
      );
      
      logger.info(`Found transitive dependents for ${bulkDependentsMap.size} changed packages`);
      for (const [changedPkg, dependents] of bulkDependentsMap) {
        logger.info(`Package ${changedPkg} affects packages: ${Array.from(dependents).join(', ')}`);
      }
      
      // Build a reverse map: dependent package -> changed packages that affect it
      const dependentToChangedMap = new Map<string, Set<string>>();
      for (const [changedPkg, dependents] of bulkDependentsMap) {
        for (const dependent of dependents) {
          if (!dependentToChangedMap.has(dependent)) {
            dependentToChangedMap.set(dependent, new Set());
          }
          dependentToChangedMap.get(dependent)!.add(changedPkg);
        }
      }
      
      logger.info(`Reverse map has ${dependentToChangedMap.size} dependent packages`);
      
      // Process transitive impacts
      for (const [dependentPackage, affectingChangedPackages] of dependentToChangedMap) {
        const dependentActions = actions.filter(a => 
          a.package === dependentPackage && !processedActions.has(a.id)
        );
        
        logger.info(`Package ${dependentPackage} has ${dependentActions.length} actions to check`);
        
        for (const action of dependentActions) {
          logger.info(`Checking if action ${action.target} uses inputs from changed packages: ${Array.from(affectingChangedPackages).join(', ')}`);
          
          // Verify this action actually uses inputs from changed packages
          if (await this.actionUsesChangedInputs(action, affectingChangedPackages)) {
            impactedActions.push(action);
            processedActions.add(action.id);
            logger.info(`✓ Action ${action.target} is transitively impacted`);
          } else {
            logger.info(`✗ Action ${action.target} does not use inputs from changed packages`);
          }
        }
      }
    } else {
      // Fallback to old method if dependency graph not available
      logger.warn('No dependency graph available, using fallback method');
      // ... fallback implementation if needed
    }
    
    logger.info(`Found ${impactedActions.length} impacted actions from ${actions.length} total (${targetScope ? 'scoped to ' + targetScope : 'unscoped'})`);
    return impactedActions;
  }

  /**
   * Check if an action uses inputs from changed packages
   */
  private async actionUsesChangedInputs(action: BazelAction, changedPackages: Set<string>): Promise<boolean> {
    for (const input of action.inputs) {
      try {
        const inputPackage = await this.bazelQuery.getFilePackage(input);
        if (changedPackages.has(inputPackage)) {
          return true;
        }
      } catch (error) {
        // Fallback to path-based detection
        const inputPackage = this.extractPackageFromPath(input);
        if (changedPackages.has(inputPackage)) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Calculate accurate package hotspots with proper attribution
   */
  private async calculatePackageHotspots(
    impactedActions: BazelAction[], 
    fileChanges: FileChange[],
    dependencyGraph: PackageDependencyGraph,
    targetScope?: string
  ): Promise<PackageHotspot[]> {
    logger.info(`Calculating package hotspots with attribution analysis${targetScope ? ` within scope: ${targetScope}` : ''}`);
    
    const changedPackages = new Set(fileChanges.map(fc => fc.package));
    const packageHotspots = new Map<string, {
      totalDuration: number;
      actionCount: number;
      directActions: BazelAction[];
      transitiveActions: BazelAction[];
      contributingPackages: Set<string>;
    }>();
    
    // Initialize hotspot data for all packages
    for (const [packagePath, node] of dependencyGraph.packages) {
      packageHotspots.set(packagePath, {
        totalDuration: 0,
        actionCount: 0,
        directActions: [],
        transitiveActions: [],
        contributingPackages: new Set()
      });
    }
    
    // Attribute actions to packages
    for (const action of impactedActions) {
      if (!action.package) continue;
      
      const hotspot = packageHotspots.get(action.package);
      if (!hotspot) continue;
      
      const isDirectlyChanged = changedPackages.has(action.package);
      
      if (isDirectlyChanged) {
        // Direct impact: full attribution to the package
        hotspot.totalDuration += action.duration;
        hotspot.actionCount += 1;
        // For direct actions, contributing packages count is 1 (itself)
        const directAction = { ...action, contributingPackagesCount: 1 };
        hotspot.directActions.push(directAction);
      } else {
        // Transitive impact: attribute full duration only to changed packages that caused this action
        const contributingChangedPackages = await this.findContributingPackages(action, changedPackages);
        
        if (contributingChangedPackages.length > 0) {
          // Record this action as transitive for the executing package (but no time attribution)
          const transitiveAction = { ...action, contributingPackagesCount: contributingChangedPackages.length };
          hotspot.transitiveActions.push(transitiveAction);
          contributingChangedPackages.forEach(pkg => hotspot.contributingPackages.add(pkg));
          
          // Attribute full duration divided among contributing changed packages
          const attributionWeight = action.duration / contributingChangedPackages.length;
          
          for (const contributingPackage of contributingChangedPackages) {
            const contributingHotspot = packageHotspots.get(contributingPackage);
            if (contributingHotspot) {
              contributingHotspot.totalDuration += attributionWeight;
              contributingHotspot.actionCount += 1 / contributingChangedPackages.length;
              // For actions attributed to contributing packages, store the count
              const attributedAction = { ...action, contributingPackagesCount: contributingChangedPackages.length };
              contributingHotspot.transitiveActions.push(attributedAction);
            }
          }
        }
      }
    }
    
    // Convert to final hotspot objects
    const hotspots: PackageHotspot[] = [];
    for (const [packagePath, stats] of packageHotspots) {
      if (stats.totalDuration > 0) {
        hotspots.push({
          packagePath,
          totalDuration: Math.round(stats.totalDuration),
          actionCount: Math.round(stats.actionCount),
          averageDuration: stats.actionCount > 0 ? Math.round(stats.totalDuration / stats.actionCount) : 0,
          impactedBuilds: 1,
          directActions: stats.directActions,
          transitiveActions: stats.transitiveActions,
          contributingPackages: Array.from(stats.contributingPackages)
        });
      }
    }
    
    return hotspots.sort((a, b) => b.totalDuration - a.totalDuration);
  }

  /**
   * Find which changed packages contribute to an action's execution
   */
  private async findContributingPackages(action: BazelAction, changedPackages: Set<string>): Promise<string[]> {
    const contributingPackages: string[] = [];
    
    // Check action inputs
    for (const input of action.inputs) {
      try {
        const inputPackage = await this.bazelQuery.getFilePackage(input);
        if (changedPackages.has(inputPackage)) {
          contributingPackages.push(inputPackage);
        }
      } catch {
        // Fallback
        const inputPackage = this.extractPackageFromPath(input);
        if (changedPackages.has(inputPackage)) {
          contributingPackages.push(inputPackage);
        }
      }
    }
    
    return Array.from(new Set(contributingPackages));
  }

  /**
   * Extract package path from a file path (fallback method)
   */
  private extractPackageFromPath(filePath: string): string {
    const parts = filePath.split('/');
    return parts.slice(0, -1).join('/') || '.';
  }

  /**
   * Extract package path from a Bazel target (fallback method)
   */
  private extractPackageFromTarget(target: string): string {
    if (target.startsWith('//')) {
      const colonIndex = target.indexOf(':');
      return colonIndex > 0 ? target.slice(2, colonIndex) : target.slice(2);
    }
    return target;
  }
}