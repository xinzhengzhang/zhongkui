import { BazelAction, FileChange, BuildAnalysis, PackageHotspot } from '../types';
import { BazelQuery, DependencyGraph } from '../bazel/query';
import { logger } from '../utils/logger';
import { promises as fs } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

export interface BazelOptions {
  bazelBinary?: string;
  startupOpts?: string;
  commandOpts?: string;
  cacheMode?: 'force' | 'auto';
}

/**
 * 简化的依赖分析器 - 按照用户需求重新设计
 */
export class SimpleDependencyAnalyzer {
  private bazelQuery: BazelQuery;
  private repoRoot: string;
  private cacheDir: string;

  constructor(repoRoot: string) {
    this.repoRoot = repoRoot;
    this.bazelQuery = new BazelQuery(repoRoot);
    this.cacheDir = join(repoRoot, '.zhongkui');
  }

  /**
   * 核心分析逻辑：
   * 1. Git diff -> 变更的 bazel packages
   * 2. Bazel cquery deps() -> 依赖图
   * 3. Profile -> 所有 actions 及其 packages
   * 4. 归因：每个 action 追溯到哪个变更 package
   */
  async analyze(actions: BazelAction[], fileChanges: FileChange[], targetScope: string, bazelOptions?: BazelOptions): Promise<BuildAnalysis> {
    logger.info(`Starting simplified analysis: ${actions.length} actions, ${fileChanges.length} file changes, target: ${targetScope}`);

    // Step 1: 提取变更的 packages
    const changedPackages = this.extractChangedPackages(fileChanges);
    logger.info(`Changed packages: ${Array.from(changedPackages).join(', ')}`);

    // Step 2: 构建依赖图
    const dependencyGraph = await this.bazelQuery.buildDependencyGraph(targetScope, bazelOptions);
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
    const attributions = await this.attributeActionsToChanges(actionsWithPackages, changedPackages, dependencyGraph, bazelOptions);

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
   * 优化版本：预处理依赖关系，避免重复计算
   */
  private async attributeActionsToChanges(
    actions: BazelAction[], 
    changedPackages: Set<string>, 
    dependencyGraph: DependencyGraph,
    bazelOptions?: BazelOptions
  ): Promise<Array<BazelAction & { contributingPackages: string[] }>> {
    logger.info(`\n=== Attribution Analysis ===`);
    logger.info(`Changed packages: ${Array.from(changedPackages).join(', ')}`);
    logger.info(`Analyzing ${actions.length} actions for attribution...\n`);
    
    // 优化：预计算依赖关系映射（支持缓存）
    const targetDependencyCache = await this.precomputeDependencyMappingsWithCache(
      changedPackages, 
      dependencyGraph,
      bazelOptions?.cacheMode || 'auto'
    );
    
    return actions.map((action, index) => {
      const contributingPackages = this.findContributingPackagesFast(action, changedPackages, targetDependencyCache);
      
      if (contributingPackages.length > 0) {
        logger.info(`✓ Action ${action.target} (${action.duration}ms) <- [${contributingPackages.join(', ')}]`);
        if (contributingPackages.length > 1) {
          logger.info(`  └─ Duration will be split: ${Math.round(action.duration / contributingPackages.length)}ms each`);
        }
      } else if (index < 10) { // 只显示前10个未归因的action
        logger.debug(`- Action ${action.target} (${action.duration}ms) <- no attribution`);
      }
      
      return {
        ...action,
        contributingPackages
      };
    });
  }

  /**
   * 预计算依赖关系映射，支持磁盘缓存
   */
  private async precomputeDependencyMappingsWithCache(
    changedPackages: Set<string>, 
    dependencyGraph: DependencyGraph,
    cacheMode: 'force' | 'auto'
  ): Promise<Map<string, string[]>> {
    // 生成缓存键（基于依赖图内容和变更包）
    const cacheKey = this.generateCacheKey(changedPackages, dependencyGraph);
    const cacheFilePath = join(this.cacheDir, `dependency-mappings-${cacheKey}.json`);
    
    logger.info(`Using cache mode: ${cacheMode}`);
    
    // 检查是否使用缓存
    if (cacheMode === 'auto') {
      const cachedResult = await this.loadFromCache(cacheFilePath);
      if (cachedResult) {
        logger.info(`Loaded dependency mappings from cache: ${cacheFilePath}`);
        return cachedResult;
      }
    }
    
    // 计算依赖映射
    logger.info('Computing dependency mappings...');
    const result = this.precomputeDependencyMappings(changedPackages, dependencyGraph);
    
    // 保存到缓存
    await this.saveToCache(cacheFilePath, result);
    
    return result;
  }

  /**
   * 生成缓存键
   */
  private generateCacheKey(changedPackages: Set<string>, dependencyGraph: DependencyGraph): string {
    // 基于变更包和依赖图的哈希
    const input = {
      changedPackages: Array.from(changedPackages).sort(),
      dependencyGraphHash: this.hashDependencyGraph(dependencyGraph)
    };
    
    return createHash('sha256')
      .update(JSON.stringify(input))
      .digest('hex')
      .substring(0, 16); // 使用前16个字符
  }

  /**
   * 生成依赖图的哈希
   */
  private hashDependencyGraph(dependencyGraph: DependencyGraph): string {
    // 基于节点数量和边的关键信息生成哈希
    const key = {
      nodeCount: dependencyGraph.nodes.size,
      edgeCount: dependencyGraph.edges.length,
      // 取前100条边作为样本来生成哈希，避免处理过大的数据
      sampleEdges: dependencyGraph.edges
        .slice(0, 100)
        .map(e => `${e.from}->${e.to}`)
        .sort()
    };
    
    return createHash('sha256')
      .update(JSON.stringify(key))
      .digest('hex')
      .substring(0, 8);
  }

  /**
   * 从缓存加载
   */
  private async loadFromCache(cacheFilePath: string): Promise<Map<string, string[]> | null> {
    try {
      const data = await fs.readFile(cacheFilePath, 'utf8');
      const parsed = JSON.parse(data);
      
      // 验证缓存格式
      if (parsed && parsed.version === '1.0' && parsed.mappings) {
        const result = new Map<string, string[]>();
        Object.entries(parsed.mappings).forEach(([key, value]) => {
          if (Array.isArray(value)) {
            result.set(key, value as string[]);
          }
        });
        
        logger.info(`Cache loaded: ${result.size} mappings`);
        return result;
      }
    } catch (error) {
      logger.debug(`Failed to load cache from ${cacheFilePath}:`, error);
    }
    
    return null;
  }

  /**
   * 保存到缓存
   */
  private async saveToCache(cacheFilePath: string, mappings: Map<string, string[]>): Promise<void> {
    try {
      // 确保缓存目录存在
      await fs.mkdir(this.cacheDir, { recursive: true });
      
      const cacheData = {
        version: '1.0',
        timestamp: new Date().toISOString(),
        mappings: Object.fromEntries(mappings)
      };
      
      await fs.writeFile(cacheFilePath, JSON.stringify(cacheData, null, 2));
      logger.info(`Cache saved: ${mappings.size} mappings to ${cacheFilePath}`);
    } catch (error) {
      logger.warn(`Failed to save cache to ${cacheFilePath}:`, error);
    }
  }

  /**
   * 预计算依赖关系映射，避免重复遍历（无缓存版本）
   */
  private precomputeDependencyMappings(
    changedPackages: Set<string>, 
    dependencyGraph: DependencyGraph
  ): Map<string, string[]> {
    logger.info('Precomputing dependency mappings...');
    
    const targetDependencyCache = new Map<string, string[]>();
    
    // 为每个target预计算它依赖的changed packages
    for (const target of dependencyGraph.nodes) {
      const targetPackage = this.extractPackageFromTarget(target);
      const contributingPackages: string[] = [];
      
      // 情况1：target直接在changed package中
      if (targetPackage && changedPackages.has(targetPackage)) {
        contributingPackages.push(targetPackage);
      }
      
      // 情况2：target依赖changed packages
      for (const changedPkg of changedPackages) {
        if (!contributingPackages.includes(changedPkg)) {
          // 检查direct dependencies
          const hasDirectDep = dependencyGraph.edges.some(edge => 
            edge.from === target && edge.toPackage === changedPkg
          );
          
          if (hasDirectDep) {
            contributingPackages.push(changedPkg);
          } else {
            // 检查package-level dependencies（更快的fallback）
            const actionPackageDeps = dependencyGraph.packageDependencies.get(targetPackage || '');
            if (actionPackageDeps && actionPackageDeps.has(changedPkg)) {
              contributingPackages.push(changedPkg);
            }
          }
        }
      }
      
      if (contributingPackages.length > 0) {
        targetDependencyCache.set(target, contributingPackages);
      }
    }
    
    logger.info(`Precomputed mappings for ${targetDependencyCache.size} targets with dependencies`);
    return targetDependencyCache;
  }

  /**
   * 使用预计算的映射快速查找贡献packages
   */
  private findContributingPackagesFast(
    action: BazelAction, 
    changedPackages: Set<string>, 
    targetDependencyCache: Map<string, string[]>
  ): string[] {
    // 直接从cache中查找
    return targetDependencyCache.get(action.target) || [];
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

  /**
   * 提取变更的 packages
   */
  private extractChangedPackages(fileChanges: FileChange[]): Set<string> {
    return new Set(fileChanges.map(fc => fc.package));
  }
}