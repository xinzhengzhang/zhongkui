import { BazelAction, FileChange, BuildAnalysis, PackageHotspot } from '../types';
import { BazelQuery, DependencyGraph } from '../bazel/query';
import { logger } from '../utils/logger';
import { promises as fs } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import { cpus } from 'os';

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
        // 判断归因类型
        const actionPackage = this.extractPackageFromTarget(action.target);
        const isDirectAttribution = actionPackage && changedPackages.has(actionPackage);
        const attributionType = isDirectAttribution ? 'Direct' : 'Transitive';
        
        logger.info(`✓ Action ${action.target} (${action.duration}ms) <- [${contributingPackages.join(', ')}] (${attributionType})`);
        
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
    
    // 决定使用哪种计算方法
    const nodeCount = dependencyGraph.nodes.size;
    const edgeCount = dependencyGraph.edges.length;
    
    let result: Map<string, string[]>;
    
    // 对于大型项目，使用并行处理
    if (nodeCount > 5000 && edgeCount > 10000) {
      logger.info(`Large dataset detected (${nodeCount} nodes, ${edgeCount} edges). Using parallel processing...`);
      result = await this.precomputeDependencyMappingsParallel(changedPackages, dependencyGraph);
    } else {
      logger.info(`Using optimized single-thread processing for ${nodeCount} nodes, ${edgeCount} edges...`);
      result = this.precomputeDependencyMappingsOptimized(changedPackages, dependencyGraph);
    }
    
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
   * 并行处理版本：使用Worker Threads处理大型数据集
   */
  private async precomputeDependencyMappingsParallel(
    changedPackages: Set<string>, 
    dependencyGraph: DependencyGraph
  ): Promise<Map<string, string[]>> {
    const numCPUs = cpus().length;
    const numWorkers = Math.min(numCPUs, 8); // 最多8个worker
    
    logger.info(`Using ${numWorkers} worker threads for parallel processing`);
    
    const nodes = Array.from(dependencyGraph.nodes);
    const chunkSize = Math.ceil(nodes.length / numWorkers);
    const chunks: string[][] = [];
    
    for (let i = 0; i < nodes.length; i += chunkSize) {
      chunks.push(nodes.slice(i, i + chunkSize));
    }
    
    // 预计算传递性依赖
    const transitivelyAffectedTargets = this.computeTransitivelyAffectedTargets(
      dependencyGraph, 
      changedPackages
    );
    
    // 准备worker数据
    const workerData = {
      dependencyGraph: {
        edges: dependencyGraph.edges,
        packageDependencies: Array.from(dependencyGraph.packageDependencies || new Map())
      },
      changedPackages: Array.from(changedPackages),
      transitivelyAffectedTargets: Array.from(transitivelyAffectedTargets)
    };
    
    // 创建workers
    const workers: Worker[] = [];
    const promises: Promise<Map<string, string[]>>[] = [];
    
    try {
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const workerPromise = new Promise<Map<string, string[]>>((resolve, reject) => {
          const worker = new Worker(__filename, {
            workerData: {
              ...workerData,
              chunk,
              workerId: i
            }
          });
          
          workers.push(worker);
          
          worker.on('message', (result) => {
            const resultMap = new Map<string, string[]>();
            Object.entries(result).forEach(([key, value]) => {
              if (Array.isArray(value)) {
                resultMap.set(key, value as string[]);
              }
            });
            resolve(resultMap);
          });
          
          worker.on('error', reject);
          worker.on('exit', (code) => {
            if (code !== 0) {
              reject(new Error(`Worker stopped with exit code ${code}`));
            }
          });
        });
        
        promises.push(workerPromise);
      }
      
      // 等待所有worker完成
      const results = await Promise.all(promises);
      
      // 合并结果
      const finalResult = new Map<string, string[]>();
      for (const result of results) {
        for (const [key, value] of result) {
          finalResult.set(key, value);
        }
      }
      
      logger.info(`Parallel processing completed: ${finalResult.size} mappings computed`);
      return finalResult;
      
    } finally {
      // 清理workers
      for (const worker of workers) {
        await worker.terminate();
      }
    }
  }
  
  /**
   * 优化的单线程版本：针对中小型数据集的高性能实现
   */
  private precomputeDependencyMappingsOptimized(
    changedPackages: Set<string>, 
    dependencyGraph: DependencyGraph
  ): Map<string, string[]> {
    logger.info('Precomputing dependency mappings (optimized single-thread)...');
    const startTime = Date.now();
    
    // 早期退出：如果没有changed packages，直接返回空结果
    if (changedPackages.size === 0) {
      logger.info('No changed packages, returning empty mappings');
      return new Map();
    }
    
    const targetDependencyCache = new Map<string, string[]>();
    
    // 建立高效索引
    const edgeIndex = this.buildOptimizedEdgeIndex(dependencyGraph.edges, changedPackages);
    const packageDeps = dependencyGraph.packageDependencies || new Map();
    
    // 新增：建立传递性依赖查找
    const transitivelyAffectedTargets = this.computeTransitivelyAffectedTargets(
      dependencyGraph, 
      changedPackages
    );
    
    logger.info(`Found ${transitivelyAffectedTargets.size} transitively affected targets`);
    
    // 处理所有节点（不再过滤，因为传递依赖可能很复杂）
    let processedCount = 0;
    for (const target of dependencyGraph.nodes) {
      const targetPackage = this.extractPackageFromTarget(target);
      const contributingPackages: string[] = [];
      
      // 情况1：target直接在changed package中
      if (targetPackage && changedPackages.has(targetPackage)) {
        contributingPackages.push(targetPackage);
      }
      
      // 情况2：使用预建索引快速查找直接依赖
      const directDeps = edgeIndex.get(target);
      if (directDeps) {
        contributingPackages.push(...directDeps.filter(pkg => !contributingPackages.includes(pkg)));
      }
      
      // 情况3：package-level fallback
      if (targetPackage) {
        const pkgDeps = packageDeps.get(targetPackage);
        if (pkgDeps) {
          for (const changedPkg of changedPackages) {
            if (pkgDeps.has(changedPkg) && !contributingPackages.includes(changedPkg)) {
              contributingPackages.push(changedPkg);
            }
          }
        }
      }
      
      // 情况4：传递性依赖
      if (contributingPackages.length === 0 && transitivelyAffectedTargets.has(target)) {
        const transitiveContributions = transitivelyAffectedTargets.get(target)!;
        contributingPackages.push(...transitiveContributions);
      }
      
      if (contributingPackages.length > 0) {
        targetDependencyCache.set(target, contributingPackages);
      }
      
      processedCount++;
      if (processedCount % 5000 === 0) {
        const elapsed = Date.now() - startTime;
        logger.info(`  Processed ${processedCount}/${dependencyGraph.nodes.size} nodes (${elapsed}ms)`);
      }
    }
    
    const totalTime = Date.now() - startTime;
    logger.info(`Optimized precomputation completed: ${targetDependencyCache.size} mappings in ${totalTime}ms`);
    
    return targetDependencyCache;
  }

  /**
   * 预计算依赖关系映射，避免重复遍历（原版本，保留向后兼容）
   */
  private precomputeDependencyMappings(
    changedPackages: Set<string>, 
    dependencyGraph: DependencyGraph
  ): Map<string, string[]> {
    logger.info('Precomputing dependency mappings...');
    const startTime = Date.now();
    
    const targetDependencyCache = new Map<string, string[]>();
    
    // 性能优化1: 预建立索引结构
    const edgeIndex = this.buildEdgeIndex(dependencyGraph.edges);
    const packageTargetsIndex = this.buildPackageTargetsIndex(dependencyGraph.nodes);
    
    // 性能优化2: 预计算package到package的映射
    const packageDeps = dependencyGraph.packageDependencies || new Map();
    
    // 性能优化3: 批量处理changed packages的targets
    const changedPackageTargets = new Set<string>();
    for (const pkg of changedPackages) {
      const targets = packageTargetsIndex.get(pkg) || [];
      targets.forEach(target => changedPackageTargets.add(target));
    }
    
    // 新增：计算传递性依赖
    const transitivelyAffectedTargets = this.computeTransitivelyAffectedTargets(
      dependencyGraph, 
      changedPackages
    );
    
    logger.info(`Index built: ${edgeIndex.size} edge groups, ${changedPackageTargets.size} changed targets, ${transitivelyAffectedTargets.size} transitively affected`);
    
    // 使用并行处理（分批处理）
    const batchSize = Math.max(1000, Math.floor(dependencyGraph.nodes.size / 10));
    const nodeArray = Array.from(dependencyGraph.nodes);
    const batches: string[][] = [];
    
    for (let i = 0; i < nodeArray.length; i += batchSize) {
      batches.push(nodeArray.slice(i, i + batchSize));
    }
    
    logger.info(`Processing ${nodeArray.length} targets in ${batches.length} batches of size ${batchSize}`);
    
    // 处理每个批次
    let processedCount = 0;
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      
      for (const target of batch) {
        const targetPackage = this.extractPackageFromTarget(target);
        const contributingPackages: string[] = [];
        
        // 情况1：target直接在changed package中
        if (targetPackage && changedPackages.has(targetPackage)) {
          contributingPackages.push(targetPackage);
        }
        
        // 情况2：target依赖changed packages（使用索引快速查找）
        const targetEdges = edgeIndex.get(target) || [];
        const dependentPackages = new Set<string>();
        
        // 从direct dependencies收集
        for (const edge of targetEdges) {
          if (changedPackages.has(edge.toPackage)) {
            dependentPackages.add(edge.toPackage);
          }
        }
        
        // 从package-level dependencies收集（fallback）
        if (targetPackage) {
          const pkgDeps = packageDeps.get(targetPackage);
          if (pkgDeps) {
            for (const changedPkg of changedPackages) {
              if (pkgDeps.has(changedPkg)) {
                dependentPackages.add(changedPkg);
              }
            }
          }
        }
        
        // 合并结果
        for (const pkg of dependentPackages) {
          if (!contributingPackages.includes(pkg)) {
            contributingPackages.push(pkg);
          }
        }
        
        // 情况3：传递性依赖
        if (contributingPackages.length === 0 && transitivelyAffectedTargets.has(target)) {
          const transitiveContributions = transitivelyAffectedTargets.get(target)!;
          contributingPackages.push(...transitiveContributions);
        }
        
        if (contributingPackages.length > 0) {
          targetDependencyCache.set(target, contributingPackages);
        }
        
        processedCount++;
      }
      
      // 进度报告
      if (batchIndex % Math.max(1, Math.floor(batches.length / 10)) === 0 || batchIndex === batches.length - 1) {
        const progress = Math.round((processedCount / nodeArray.length) * 100);
        const elapsed = Date.now() - startTime;
        logger.info(`  Progress: ${progress}% (${processedCount}/${nodeArray.length} targets, ${elapsed}ms elapsed)`);
      }
    }
    
    const totalTime = Date.now() - startTime;
    logger.info(`Precomputed mappings for ${targetDependencyCache.size} targets with dependencies in ${totalTime}ms`);
    
    return targetDependencyCache;
  }
  
  /**
   * 建立边的索引以快速查找
   */
  private buildEdgeIndex(edges: Array<{from: string, to: string, toPackage: string}>): Map<string, Array<{to: string, toPackage: string}>> {
    const index = new Map<string, Array<{to: string, toPackage: string}>>();
    
    for (const edge of edges) {
      if (!index.has(edge.from)) {
        index.set(edge.from, []);
      }
      index.get(edge.from)!.push({ to: edge.to, toPackage: edge.toPackage });
    }
    
    return index;
  }
  
  /**
   * 建立package到targets的索引
   */
  private buildPackageTargetsIndex(nodes: Set<string>): Map<string, string[]> {
    const index = new Map<string, string[]>();
    
    for (const node of nodes) {
      const pkg = this.extractPackageFromTarget(node);
      if (!index.has(pkg)) {
        index.set(pkg, []);
      }
      index.get(pkg)!.push(node);
    }
    
    return index;
  }
  
  /**
   * 建立优化的边索引，只关注changed packages
   */
  private buildOptimizedEdgeIndex(
    edges: Array<{from: string, to: string, toPackage: string}>, 
    changedPackages: Set<string>
  ): Map<string, string[]> {
    const index = new Map<string, string[]>();
    
    // 只索引指向changed packages的边
    for (const edge of edges) {
      if (changedPackages.has(edge.toPackage)) {
        if (!index.has(edge.from)) {
          index.set(edge.from, []);
        }
        const deps = index.get(edge.from)!;
        if (!deps.includes(edge.toPackage)) {
          deps.push(edge.toPackage);
        }
      }
    }
    
    return index;
  }
  
  /**
   * 过滤出可能受影响的节点
   */
  private filterRelevantNodes(
    allNodes: Set<string>, 
    changedPackages: Set<string>,
    edgeIndex: Map<string, string[]>,
    packageDeps: Map<string, Set<string>>
  ): string[] {
    const relevant: string[] = [];
    
    for (const node of allNodes) {
      const nodePackage = this.extractPackageFromTarget(node);
      
      // 包含节点如果：
      // 1. 直接在changed package中
      if (nodePackage && changedPackages.has(nodePackage)) {
        relevant.push(node);
        continue;
      }
      
      // 2. 在edge索引中（有直接依赖到changed packages）
      if (edgeIndex.has(node)) {
        relevant.push(node);
        continue;
      }
      
      // 3. package有依赖到changed packages
      if (nodePackage) {
        const deps = packageDeps.get(nodePackage);
        if (deps) {
          let hasChangedDep = false;
          for (const changedPkg of changedPackages) {
            if (deps.has(changedPkg)) {
              hasChangedDep = true;
              break;
            }
          }
          if (hasChangedDep) {
            relevant.push(node);
          }
        }
      }
    }
    
    return relevant;
  }
  
  /**
   * 计算传递性依赖的目标（新增方法）
   */
  private computeTransitivelyAffectedTargets(
    dependencyGraph: DependencyGraph, 
    changedPackages: Set<string>
  ): Map<string, string[]> {
    logger.info('Computing transitive dependencies...');
    const startTime = Date.now();
    
    const result = new Map<string, string[]>();
    
    // 首先找到所有changed packages中的targets
    const changedTargets = new Set<string>();
    for (const node of dependencyGraph.nodes) {
      const nodePackage = this.extractPackageFromTarget(node);
      if (nodePackage && changedPackages.has(nodePackage)) {
        changedTargets.add(node);
      }
    }
    
    logger.info(`Found ${changedTargets.size} targets in changed packages`);
    
    // 构建反向依赖图（谁依赖谁）
    const reverseDependencies = new Map<string, Set<string>>();
    for (const edge of dependencyGraph.edges) {
      if (!reverseDependencies.has(edge.to)) {
        reverseDependencies.set(edge.to, new Set());
      }
      reverseDependencies.get(edge.to)!.add(edge.from);
    }
    
    logger.info(`Built reverse dependency graph with ${reverseDependencies.size} nodes`);
    
    // 使用广度优先搜索找到所有传递依赖
    const visited = new Set<string>();
    const queue: Array<{target: string, sourceChangedPackages: Set<string>}> = [];
    
    // 初始化队列
    for (const changedTarget of changedTargets) {
      const changedPackage = this.extractPackageFromTarget(changedTarget);
      if (changedPackage) {
        queue.push({ 
          target: changedTarget, 
          sourceChangedPackages: new Set([changedPackage])
        });
      }
    }
    
    let processedCount = 0;
    while (queue.length > 0) {
      const { target, sourceChangedPackages } = queue.shift()!;
      
      if (visited.has(target)) {
        // 如果已经访问过，合并source packages
        const existing = result.get(target);
        if (existing) {
          for (const pkg of sourceChangedPackages) {
            if (!existing.includes(pkg)) {
              existing.push(pkg);
            }
          }
        }
        continue;
      }
      
      visited.add(target);
      result.set(target, Array.from(sourceChangedPackages));
      
      // 找到所有依赖当前target的targets
      const dependents = reverseDependencies.get(target);
      if (dependents) {
        for (const dependent of dependents) {
          if (!visited.has(dependent)) {
            queue.push({
              target: dependent,
              sourceChangedPackages: new Set(sourceChangedPackages)
            });
          }
        }
      }
      
      processedCount++;
      if (processedCount % 1000 === 0) {
        logger.info(`  Processed ${processedCount} targets in transitive search, queue: ${queue.length}`);
      }
    }
    
    const totalTime = Date.now() - startTime;
    logger.info(`Computed transitive dependencies: ${result.size} affected targets in ${totalTime}ms`);
    
    return result;
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
  
  /**
   * 从target提取package (静态方法供worker使用)
   */
  public static extractPackageFromTargetStatic(target: string): string {
    if (target.startsWith('//')) {
      const colonIndex = target.indexOf(':');
      return colonIndex > 0 ? target.slice(2, colonIndex) : target.slice(2);
    }
    return target;
  }
}

// Worker线程处理逻辑
if (!isMainThread && parentPort) {
  const { chunk, dependencyGraph, changedPackages, workerId, transitivelyAffectedTargets } = workerData;
  
  const result: Record<string, string[]> = {};
  const changedPackagesSet = new Set(changedPackages as string[]);
  const packageDepsMap = new Map(dependencyGraph.packageDependencies as [string, Set<string>][]);
  const transitiveTargetsMap = new Map(transitivelyAffectedTargets as [string, string[]][]);
  
  // 建立edge索引
  const edgeIndex = new Map<string, string[]>();
  for (const edge of dependencyGraph.edges as Array<{from: string, to: string, toPackage: string}>) {
    if (changedPackagesSet.has(edge.toPackage)) {
      if (!edgeIndex.has(edge.from)) {
        edgeIndex.set(edge.from, []);
      }
      const deps = edgeIndex.get(edge.from)!;
      if (!deps.includes(edge.toPackage)) {
        deps.push(edge.toPackage);
      }
    }
  }
  
  // 处理分配给这个worker的chunk
  for (const target of chunk as string[]) {
    const targetPackage = SimpleDependencyAnalyzer.extractPackageFromTargetStatic(target);
    const contributingPackages: string[] = [];
    
    // 情况1：target直接在changed package中
    if (targetPackage && changedPackagesSet.has(targetPackage)) {
      contributingPackages.push(targetPackage);
    }
    
    // 情况2：target依赖changed packages（使用索引）
    const directDeps = edgeIndex.get(target);
    if (directDeps) {
      for (const pkg of directDeps) {
        if (!contributingPackages.includes(pkg)) {
          contributingPackages.push(pkg);
        }
      }
    }
    
    // 情况3：package-level dependencies
    if (targetPackage) {
      const pkgDeps = packageDepsMap.get(targetPackage);
      if (pkgDeps) {
        for (const changedPkg of changedPackagesSet) {
          if (pkgDeps.has(changedPkg) && !contributingPackages.includes(changedPkg)) {
            contributingPackages.push(changedPkg);
          }
        }
      }
    }
    
    // 情况4：传递性依赖
    if (contributingPackages.length === 0 && transitiveTargetsMap.has(target)) {
      const transitiveContributions = transitiveTargetsMap.get(target)!;
      contributingPackages.push(...transitiveContributions);
    }
    
    if (contributingPackages.length > 0) {
      result[target] = contributingPackages;
    }
  }
  
  parentPort.postMessage(result);
}