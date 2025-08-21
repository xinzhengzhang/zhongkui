import { BazelAction, FileChange, BuildAnalysis, PackageHotspot, PackageDependencyGraph, PackageNode } from '../types';
import { BazelQuery } from '../bazel/query';
import { logger } from '../utils/logger';

/**
 * Analyzes dependencies between actions and file changes to determine build impact
 * Uses Bazel query to accurately map actions to packages and understand dependency relationships
 */
export class DependencyAnalyzer {
  private bazelQuery: BazelQuery;
  private packageCache = new Map<string, string>(); // Cache for target -> package mapping

  constructor(repoRoot: string) {
    this.bazelQuery = new BazelQuery(repoRoot);
  }

  /**
   * Analyze the relationship between file changes and action executions
   */
  async analyze(actions: BazelAction[], fileChanges: FileChange[], targetScope?: string): Promise<BuildAnalysis> {
    logger.info(`Analyzing dependencies for ${actions.length} actions and ${fileChanges.length} file changes${targetScope ? ` within scope: ${targetScope}` : ''}`);

    // Step 1: Resolve packages for all actions using Bazel query
    const actionsWithPackages = await this.resolveActionPackages(actions);
    
    // Step 2: Build dependency graph within target scope
    const dependencyGraph = await this.buildPackageDependencyGraph(actionsWithPackages, fileChanges, targetScope);
    
    // Step 3: Find impacted actions based on file changes and dependencies
    const impactedActions = await this.findImpactedActions(actionsWithPackages, fileChanges, dependencyGraph, targetScope);
    
    // Step 4: Calculate accurate package hotspots with proper attribution
    const packageHotspots = await this.calculatePackageHotspots(impactedActions, fileChanges, dependencyGraph, targetScope);

    return {
      profileId: '', // Will be set by caller
      fileChanges,
      impactedActions,
      packageHotspots,
      packageDependencyGraph: dependencyGraph
    };
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
    
    // Build nodes for each package
    for (const packagePath of allPackages) {
      const packageActions = actions.filter(a => a.package === packagePath);
      
      try {
        const dependencies = await this.bazelQuery.getPackageDependencies(packagePath);
        const dependents = await this.bazelQuery.getPackageDependents(packagePath, targetScope);
        
        packageNodes.set(packagePath, {
          packagePath,
          dependencies,
          dependents,
          actions: packageActions,
          impactWeight: 1.0 // Will be calculated based on change impact
        });
      } catch (error) {
        logger.warn(`Failed to get dependencies for package ${packagePath}:`, error);
        packageNodes.set(packagePath, {
          packagePath,
          dependencies: [],
          dependents: [],
          actions: packageActions,
          impactWeight: 1.0
        });
      }
    }
    
    return { packages: packageNodes };
  }

  /**
   * Find actions impacted by file changes using dependency analysis
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
    
    // Direct impact: actions in changed packages
    for (const action of actions) {
      if (action.package && changedPackages.has(action.package)) {
        impactedActions.push(action);
        processedActions.add(action.id);
      }
    }
    
    // Transitive impact: actions in packages that depend on changed packages (within target scope)
    for (const changedPackage of changedPackages) {
      const packageNode = dependencyGraph.packages.get(changedPackage);
      if (!packageNode) continue;
      
      // Get all packages that depend on this changed package within target scope
      const transitiveDependents = await this.bazelQuery.getTransitiveDependents(changedPackage, targetScope);
      
      for (const dependentPackage of transitiveDependents) {
        const dependentActions = actions.filter(a => 
          a.package === dependentPackage && !processedActions.has(a.id)
        );
        
        for (const action of dependentActions) {
          // Verify this action actually uses inputs from changed packages
          if (await this.actionUsesChangedInputs(action, changedPackages)) {
            impactedActions.push(action);
            processedActions.add(action.id);
          }
        }
      }
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
        hotspot.directActions.push(action);
      } else {
        // Transitive impact: attribute full duration only to changed packages that caused this action
        const contributingChangedPackages = await this.findContributingPackages(action, changedPackages);
        
        if (contributingChangedPackages.length > 0) {
          // Record this action as transitive for the executing package (but no time attribution)
          hotspot.transitiveActions.push(action);
          contributingChangedPackages.forEach(pkg => hotspot.contributingPackages.add(pkg));
          
          // Attribute full duration divided among contributing changed packages
          const attributionWeight = action.duration / contributingChangedPackages.length;
          
          for (const contributingPackage of contributingChangedPackages) {
            const contributingHotspot = packageHotspots.get(contributingPackage);
            if (contributingHotspot) {
              contributingHotspot.totalDuration += attributionWeight;
              contributingHotspot.actionCount += 1 / contributingChangedPackages.length;
              contributingHotspot.transitiveActions.push(action);
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
    
    // Also check if the action's package depends on any changed packages
    if (action.package) {
      try {
        const dependencies = await this.bazelQuery.getPackageDependencies(action.package);
        for (const dep of dependencies) {
          if (changedPackages.has(dep)) {
            contributingPackages.push(dep);
          }
        }
      } catch {
        // Skip dependency check if query fails
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