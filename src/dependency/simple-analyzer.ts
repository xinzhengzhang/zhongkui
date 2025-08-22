import { BazelAction, FileChange, BuildAnalysis, PackageHotspot } from '../types';
import { BazelQuery, DependencyGraph } from '../bazel/query';
import { logger } from '../utils/logger';

/**
 * 简化的依赖分析器 - 按照用户需求重新设计
 */
export class SimpleDependencyAnalyzer {
  private bazelQuery: BazelQuery;

  constructor(repoRoot: string) {
    this.bazelQuery = new BazelQuery(repoRoot);
  }

  /**
   * 核心分析逻辑：
   * 1. Git diff -> 变更的 bazel packages
   * 2. Bazel cquery deps() -> 依赖图
   * 3. Profile -> 所有 actions 及其 packages
   * 4. 归因：每个 action 追溯到哪个变更 package
   */
  async analyze(actions: BazelAction[], fileChanges: FileChange[], targetScope: string): Promise<BuildAnalysis> {
    logger.info(`Starting simplified analysis: ${actions.length} actions, ${fileChanges.length} file changes, target: ${targetScope}`);

    // Step 1: 提取变更的 packages
    const changedPackages = this.extractChangedPackages(fileChanges);
    logger.info(`Changed packages: ${Array.from(changedPackages).join(', ')}`);

    // Step 2: 构建依赖图
    const dependencyGraph = await this.bazelQuery.buildDependencyGraph(targetScope);
    logger.info(`Dependency graph: ${dependencyGraph.nodes.size} nodes, ${dependencyGraph.edges.length} edges`);
    
    // Debug: 显示一些关键的依赖关系
    logger.info(`Sample dependency edges:`);
    dependencyGraph.edges.slice(0, 10).forEach(edge => {
      logger.info(`  ${edge.from} -> ${edge.to} (${edge.fromPackage} -> ${edge.toPackage})`);
    });
    
    // Debug: 检查是否包含我们关心的packages
    const allPackagesInGraph = new Set<string>();
    dependencyGraph.nodes.forEach(node => {
      const pkg = this.extractPackageFromTarget(node);
      allPackagesInGraph.add(pkg);
    });
    logger.info(`Packages in dependency graph: ${Array.from(allPackagesInGraph).slice(0, 20).join(', ')}${allPackagesInGraph.size > 20 ? ` (and ${allPackagesInGraph.size - 20} more)` : ''}`);
    
    // 特别检查是否包含变更的packages
    for (const changedPkg of changedPackages) {
      const hasTargetsInGraph = Array.from(dependencyGraph.nodes).some(node => 
        this.extractPackageFromTarget(node) === changedPkg
      );
      logger.info(`Changed package ${changedPkg} has targets in dependency graph: ${hasTargetsInGraph}`);
    }

    // Step 3: 为每个 action 解析其 package
    const actionsWithPackages = await this.resolveActionPackages(actions);
    logger.info(`Actions with packages: ${actionsWithPackages.length} total`);

    // Step 4: 归因分析 - 每个 action 追溯到变更的 packages
    const attributions = this.attributeActionsToChanges(actionsWithPackages, changedPackages, dependencyGraph);

    // Step 5: 生成每个变更 package 的统计
    const packageHotspots = this.calculatePackageStats(attributions, changedPackages);

    return {
      profileId: '',
      fileChanges,
      impactedActions: attributions.filter(a => a.contributingPackages.length > 0),
      packageHotspots,
      packageDependencyGraph: { packages: new Map() } // 简化，不需要复杂的 package graph
    };
  }

  /**
   * 提取变更的 packages
   */
  private extractChangedPackages(fileChanges: FileChange[]): Set<string> {
    return new Set(fileChanges.map(fc => fc.package));
  }

  /**
   * 为每个 action 解析其所属的 package
   */
  private async resolveActionPackages(actions: BazelAction[]): Promise<BazelAction[]> {
    const resolvedActions: BazelAction[] = [];
    
    for (const action of actions) {
      try {
        const packagePath = await this.bazelQuery.mapActionToPackage(action.target);
        resolvedActions.push({
          ...action,
          package: packagePath
        });
      } catch (error) {
        // 使用 fallback
        const packagePath = this.extractPackageFromTarget(action.target);
        resolvedActions.push({
          ...action,
          package: packagePath
        });
      }
    }
    
    return resolvedActions;
  }

  /**
   * 归因分析：每个 action 追溯到哪些变更 packages
   */
  private attributeActionsToChanges(
    actions: BazelAction[], 
    changedPackages: Set<string>, 
    dependencyGraph: DependencyGraph
  ): Array<BazelAction & { contributingPackages: string[] }> {
    logger.info(`\n=== Attribution Analysis ===`);
    logger.info(`Changed packages: ${Array.from(changedPackages).join(', ')}`);
    logger.info(`Analyzing ${actions.length} actions for attribution...\n`);
    
    return actions.map(action => {
      const contributingPackages = this.findContributingPackages(action, changedPackages, dependencyGraph);
      
      if (contributingPackages.length > 0) {
        logger.info(`✓ Action ${action.target} (${action.duration}ms) <- [${contributingPackages.join(', ')}]`);
        if (contributingPackages.length > 1) {
          logger.info(`  └─ Duration will be split: ${Math.round(action.duration / contributingPackages.length)}ms each`);
        }
      } else {
        logger.debug(`- Action ${action.target} (${action.duration}ms) <- no attribution`);
      }
      
      return {
        ...action,
        contributingPackages
      };
    });
  }

  /**
   * 找到哪些变更 packages 影响了这个 action
   */
  private findContributingPackages(
    action: BazelAction, 
    changedPackages: Set<string>, 
    dependencyGraph: DependencyGraph
  ): string[] {
    const contributingPackages: string[] = [];

    // 情况1: action 直接在变更的 package 中
    if (action.package && changedPackages.has(action.package)) {
      contributingPackages.push(action.package);
      logger.debug(`  Direct: ${action.target} is in changed package ${action.package}`);
    }

    // 情况2: action 依赖变更的 packages（通过依赖图追溯）
    for (const changedPkg of changedPackages) {
      if (!contributingPackages.includes(changedPkg) && this.actionDependsOnPackage(action, changedPkg, dependencyGraph)) {
        contributingPackages.push(changedPkg);
        logger.debug(`  Transitive: ${action.target} depends on changed package ${changedPkg}`);
      }
    }

    return contributingPackages; // 已经通过 includes 检查去重了
  }

  /**
   * 检查 action 是否依赖某个 package
   */
  private actionDependsOnPackage(
    action: BazelAction, 
    packagePath: string, 
    dependencyGraph: DependencyGraph
  ): boolean {
    if (!action.target) return false;
    
    logger.debug(`    Checking if ${action.target} depends on package ${packagePath}...`);
    
    // 方法1: 直接检查 action.target 是否在依赖图中依赖该 package 中的任何 target
    let foundDirectDependency = false;
    for (const edge of dependencyGraph.edges) {
      if (edge.from === action.target && edge.toPackage === packagePath) {
        logger.debug(`    ✓ Found direct dependency: ${edge.from} -> ${edge.to} (package: ${edge.toPackage})`);
        foundDirectDependency = true;
        break;
      }
    }
    
    if (foundDirectDependency) {
      return true;
    }
    
    // 方法2: 检查 package 级别的依赖关系作为补充
    if (action.package) {
      const actionPackageDeps = dependencyGraph.packageDependencies.get(action.package);
      if (actionPackageDeps && actionPackageDeps.has(packagePath)) {
        logger.debug(`    ✓ Found package-level dependency: ${action.package} -> ${packagePath}`);
        return true;
      }
      
      logger.debug(`    ✗ No dependency found. Action package ${action.package} deps: [${actionPackageDeps ? Array.from(actionPackageDeps).join(', ') : 'none'}]`);
    }
    
    // 方法3: 检查是否有间接路径（递归检查，但限制深度避免性能问题）
    const hasIndirectPath = this.hasIndirectDependencyPath(action.target, packagePath, dependencyGraph, new Set(), 3);
    if (hasIndirectPath) {
      logger.debug(`    ✓ Found indirect dependency path from ${action.target} to package ${packagePath}`);
      return true;
    }
    
    return false;
  }

  /**
   * 检查是否有间接依赖路径
   */
  private hasIndirectDependencyPath(
    fromTarget: string,
    toPackage: string,
    dependencyGraph: DependencyGraph,
    visited: Set<string>,
    maxDepth: number
  ): boolean {
    if (maxDepth <= 0 || visited.has(fromTarget)) {
      return false;
    }
    
    visited.add(fromTarget);
    
    // 查找所有直接依赖
    for (const edge of dependencyGraph.edges) {
      if (edge.from === fromTarget) {
        // 如果直接依赖的target属于目标package
        if (edge.toPackage === toPackage) {
          return true;
        }
        
        // 递归检查间接依赖
        if (this.hasIndirectDependencyPath(edge.to, toPackage, dependencyGraph, new Set(visited), maxDepth - 1)) {
          return true;
        }
      }
    }
    
    return false;
  }

  /**
   * 计算每个变更 package 的影响统计
   */
  private calculatePackageStats(
    attributions: Array<BazelAction & { contributingPackages: string[] }>, 
    changedPackages: Set<string>
  ): PackageHotspot[] {
    const packageStats = new Map<string, {
      totalDuration: number;
      actionCount: number;
      actions: BazelAction[];
    }>();

    // 初始化每个变更 package 的统计
    for (const pkg of changedPackages) {
      packageStats.set(pkg, {
        totalDuration: 0,
        actionCount: 0,
        actions: []
      });
    }

    // 归因计算
    for (const attribution of attributions) {
      if (attribution.contributingPackages.length === 0) continue;

      // 如果被多个 package 影响，平分时间
      const durationPerPackage = attribution.duration / attribution.contributingPackages.length;

      for (const pkg of attribution.contributingPackages) {
        const stats = packageStats.get(pkg);
        if (stats) {
          stats.totalDuration += durationPerPackage;
          stats.actionCount += 1 / attribution.contributingPackages.length;
          stats.actions.push(attribution);
        }
      }
    }

    // 转换为 PackageHotspot 格式
    const hotspots: PackageHotspot[] = [];
    for (const [pkg, stats] of packageStats) {
      if (stats.totalDuration > 0) {
        // 使用实际actions数组的长度，而不是平分后的计数
        const actualActionCount = stats.actions.length;
        
        hotspots.push({
          packagePath: pkg,
          totalDuration: Math.round(stats.totalDuration),
          actionCount: actualActionCount,  // 使用实际数量
          averageDuration: actualActionCount > 0 ? Math.round(stats.totalDuration / actualActionCount) : 0,
          impactedBuilds: 1,
          directActions: stats.actions.filter(a => a.package === pkg),
          transitiveActions: stats.actions.filter(a => a.package !== pkg),
          contributingPackages: [pkg]
        });
      }
    }

    // 按总时间排序
    hotspots.sort((a, b) => b.totalDuration - a.totalDuration);

    logger.info(`Package statistics:`);
    for (const hotspot of hotspots) {
      logger.info(`  ${hotspot.packagePath}: ${hotspot.totalDuration}ms (${hotspot.actionCount} actions)`);
    }

    return hotspots;
  }

  /**
   * 从 target 提取 package
   */
  private extractPackageFromTarget(target: string): string {
    if (target.startsWith('//')) {
      const colonIndex = target.indexOf(':');
      return colonIndex > 0 ? target.slice(2, colonIndex) : target.slice(2);
    }
    return target;
  }
}