import { writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { BuildAnalysis, PackageHotspot } from '../types';
import { logger } from '../utils/logger';

/**
 * Generates reports for build hotspots and performance analysis
 */
export class HotspotReporter {
  /**
   * Generate a comprehensive report for a single build analysis
   */
  async generateReport(analysis: BuildAnalysis, outputDir: string = 'report/'): Promise<{jsonPath: string, mdPath: string}> {
    logger.info(`Generating report for profile: ${analysis.profileId}`);

    // Ensure output directory exists
    await this.ensureDirectoryExists(outputDir);

    const report = {
      invocationId: analysis.invocationId,
      timestamp: new Date().toISOString(),
      summary: this.generateSummary(analysis),
      changedPackagesAnalysis: this.generateChangedPackagesAnalysis(analysis),
      hotspots: analysis.packageHotspots,
      fileChanges: analysis.fileChanges,
      impactedActions: analysis.impactedActions.length,
      recommendations: this.generateRecommendations(analysis.packageHotspots)
    };

    const fileName = join(outputDir, `report-${analysis.invocationId || Date.now()}-${Date.now()}.json`);
    
    // Handle potential JSON.stringify memory errors gracefully
    try {
      await writeFile(fileName, JSON.stringify(report, null, null));
    } catch (error) {
      if (error instanceof RangeError && error.message.includes('Invalid string length')) {
        logger.warn('Report data too large for JSON serialization, generating simplified report');
        
        // Create a simplified report without hotspots
        const simplifiedReport = {
          invocationId: analysis.invocationId,
          timestamp: new Date().toISOString(),
          summary: report.summary,
          changedPackagesAnalysis: report.changedPackagesAnalysis,
          fileChanges: report.fileChanges,
          impactedActions: report.impactedActions,
          recommendations: report.recommendations,
        };
        
        await writeFile(fileName, JSON.stringify(simplifiedReport, null, null));
        logger.info(`Simplified JSON report generated due to memory constraints: ${fileName}`);
      } else {
        throw error; // Re-throw other errors
      }
    }
    
    // Also generate human-readable report
    const humanReport = this.generateHumanReadableReport(report, analysis);
    const humanFileName = join(outputDir, `report-${analysis.invocationId || Date.now()}-${Date.now()}.md`);
    await writeFile(humanFileName, humanReport);

    logger.info(`Reports generated: ${fileName}, ${humanFileName}`);
    
    return {
      jsonPath: fileName,
      mdPath: humanFileName
    };
  }

  /**
   * Ensure the output directory exists
   */
  private async ensureDirectoryExists(outputDir: string): Promise<void> {
    try {
      await mkdir(outputDir, { recursive: true });
    } catch (error) {
      // Directory might already exist, which is fine
      logger.debug(`Directory creation result for ${outputDir}:`, error);
    }
  }

  /**
   * Generate analysis specifically for changed packages
   */
  private generateChangedPackagesAnalysis(analysis: BuildAnalysis) {
    const changedPackages = [...new Set(analysis.fileChanges.map(fc => fc.package))];
    const changedPackageHotspots = analysis.packageHotspots.filter(h => 
      changedPackages.includes(h.packagePath)
    );
    
    const totalActualTime = changedPackageHotspots.reduce(
      (sum, h) => sum + (h.actualCompilationTime || h.directActions.reduce((s, a) => s + a.duration, 0)), 0
    );
    
    const totalTransitiveTime = changedPackageHotspots.reduce(
      (sum, h) => sum + (h.transitiveCompilationTime || 0), 0
    );
    
    return {
      changedPackages: changedPackageHotspots.length,
      totalActualCompilationTime: totalActualTime,
      totalTransitiveCompilationTime: totalTransitiveTime,
      packageBreakdown: changedPackageHotspots.map(h => ({
        package: h.packagePath,
        actualTime: h.actualCompilationTime || h.directActions.reduce((sum, action) => sum + action.duration, 0),
        transitiveTime: h.transitiveCompilationTime || 0,
        directActions: h.directActions.length,
        transitiveActions: h.transitiveActions.length,
        attributionBreakdown: h.attributionBreakdown || {},
        contributingToOthers: this.findTransitiveDependencies(h.packagePath, analysis)
      }))
    };
  }
  
  /**
   * Find which packages this changed package contributes to transitively
   */
  private findTransitiveDependencies(changedPackage: string, analysis: BuildAnalysis): Array<{package: string, actionCount: number, totalTime: number}> {
    const contributions: {[pkg: string]: {actionCount: number, totalTime: number}} = {};
    
    analysis.packageHotspots.forEach(hotspot => {
      if (hotspot.packagePath === changedPackage) return;
      
      hotspot.transitiveActions.forEach(action => {
        if (action.contributingPackages?.includes(changedPackage)) {
          if (!contributions[hotspot.packagePath]) {
            contributions[hotspot.packagePath] = {actionCount: 0, totalTime: 0};
          }
          contributions[hotspot.packagePath].actionCount++;
          contributions[hotspot.packagePath].totalTime += action.duration / (action.contributingPackagesCount || 1);
        }
      });
    });
    
    return Object.entries(contributions)
      .map(([pkg, data]) => ({package: pkg, ...data}))
      .sort((a, b) => b.totalTime - a.totalTime)
      .slice(0, 10);
  }

  /**
   * Generate summary statistics
   */
  private generateSummary(analysis: BuildAnalysis) {
    const totalDuration = analysis.packageHotspots.reduce(
      (sum, hotspot) => sum + hotspot.totalDuration, 0
    );

    const topHotspots = analysis.packageHotspots.slice(0, 10);

    return {
      totalPackages: analysis.packageHotspots.length,
      totalDuration: totalDuration,
      averagePackageDuration: totalDuration / analysis.packageHotspots.length,
      topHotspots: topHotspots.map(h => ({
        package: h.packagePath,
        duration: h.totalDuration,
        percentage: (h.totalDuration / totalDuration * 100).toFixed(2)
      }))
    };
  }

  /**
   * Format package path for display, handling empty root package
   */
  private formatPackageForDisplay(packagePath: string): string {
    return (packagePath === '' || packagePath === '.') ? '(root)' : packagePath;
  }

  /**
   * Generate optimization recommendations
   */
  private generateRecommendations(hotspots: PackageHotspot[]): string[] {
    const recommendations: string[] = [];

    // Find packages with high total duration
    const highDurationThreshold = hotspots[0]?.totalDuration * 0.1 || 1000;
    const highDurationPackages = hotspots.filter(h => h.totalDuration > highDurationThreshold);

    if (highDurationPackages.length > 0) {
      recommendations.push(
        `Consider optimizing high-duration packages: ${highDurationPackages.slice(0, 5).map(h => h.packagePath).join(', ')}`
      );
    }

    // Find packages with high action count but low average duration
    const highActionCountPackages = hotspots
      .filter(h => h.actionCount > 10 && h.averageDuration < 100)
      .slice(0, 3);

    if (highActionCountPackages.length > 0) {
      recommendations.push(
        `Consider consolidating actions in packages with many small actions: ${highActionCountPackages.map(h => h.packagePath).join(', ')}`
      );
    }

    // Find packages with very high average duration
    const highAvgDurationPackages = hotspots
      .filter(h => h.averageDuration > 1000)
      .slice(0, 3);

    if (highAvgDurationPackages.length > 0) {
      recommendations.push(
        `Investigate packages with very slow individual actions: ${highAvgDurationPackages.map(h => h.packagePath).join(', ')}`
      );
    }

    return recommendations;
  }

  /**
   * Generate human-readable markdown report
   */
  private generateHumanReadableReport(report: any, fullAnalysis: BuildAnalysis): string {
    const { summary, hotspots, recommendations } = report;
    
    let markdown = `# Build Hotspot Analysis Report

**Invocation ID:** ${report.invocationId || 'N/A'}
**Generated:** ${report.timestamp}

## Summary

- **Total Packages Analyzed:** ${summary.totalPackages}
- **Total Build Duration:** ${(summary.totalDuration / 1000).toFixed(2)}s
- **Average Package Duration:** ${(summary.averagePackageDuration / 1000).toFixed(2)}s
- **Impacted Actions:** ${report.impactedActions}

## Changed Packages Analysis

- **Changed Packages:** ${report.changedPackagesAnalysis.changedPackages}
- **Actual Compilation Time:** ${(report.changedPackagesAnalysis.totalActualCompilationTime / 1000).toFixed(2)}s
- **Transitive Compilation Time:** ${(report.changedPackagesAnalysis.totalTransitiveCompilationTime / 1000).toFixed(2)}s

### Changed Package Breakdown

| Package | Actual Time (s) | Transitive Time (s) | Direct Actions | Transitive Actions | Top Contributions |
|---------|-----------------|--------------------|--------------|--------------------|-------------------|
`;

    report.changedPackagesAnalysis.packageBreakdown.forEach((pkg: any) => {
      const topContributions = pkg.contributingToOthers.slice(0, 3)
        .map((c: any) => `${c.package}(${(c.totalTime/1000).toFixed(1)}s)`)
        .join(', ') || 'None';
      markdown += `| \`${this.formatPackageForDisplay(pkg.package)}\` | ${(pkg.actualTime / 1000).toFixed(2)} | ${(pkg.transitiveTime / 1000).toFixed(2)} | ${pkg.directActions} | ${pkg.transitiveActions} | ${topContributions} |\n`;
    });

    markdown += `\n## Top 10 Package Hotspots

| Rank | Package | Duration (s) | Actions | Avg Duration (s) | % of Total |
|------|---------|-------------|---------|------------------|------------|
`;

    hotspots.slice(0, 10).forEach((hotspot: PackageHotspot, index: number) => {
      const percentage = (hotspot.totalDuration / summary.totalDuration * 100).toFixed(2);
      markdown += `| ${index + 1} | \`${this.formatPackageForDisplay(hotspot.packagePath)}\` | ${(hotspot.totalDuration / 1000).toFixed(2)} | ${hotspot.actionCount} | ${(hotspot.averageDuration / 1000).toFixed(2)} | ${percentage}% |\n`;
    });

    if (recommendations.length > 0) {
      markdown += `\n## Recommendations

`;
      recommendations.forEach((rec: string, index: number) => {
        markdown += `${index + 1}. ${rec}\n`;
      });
    }

    markdown += `\n## File Changes

- **Total Changed Files:** ${report.fileChanges.length}

### Changed Packages:
`;

    const changedPackages = [...new Set(report.fileChanges.map((fc: any) => fc.package))];
    changedPackages.forEach(pkg => {
      markdown += `- \`${pkg}\`\n`;
    });

    // Add detailed action analysis for changed packages
    markdown += `\n## Actions Impacted by Changed Packages\n`;
    
    // Find hotspots for changed packages only
    const changedPackageSet = new Set(changedPackages);
    const changedPackageHotspots = hotspots.filter((hotspot: PackageHotspot) => 
      changedPackageSet.has(hotspot.packagePath)
    );
    
    if (changedPackageHotspots.length === 0) {
      markdown += `\n*No direct actions found in changed packages.*\n`;
    } else {
      changedPackageHotspots.forEach((hotspot: PackageHotspot) => {
        markdown += `\n### Package: \`${this.formatPackageForDisplay(hotspot.packagePath)}\`\n\n`;
        
        // Combine direct and transitive actions, then sort by proximity to changed packages
        const allActions = [...hotspot.directActions, ...hotspot.transitiveActions];
        const sortedActions = allActions
          .sort((a, b) => {
            // Priority 1: Direct actions first
            const aIsDirect = hotspot.directActions.includes(a) ? 0 : 1;
            const bIsDirect = hotspot.directActions.includes(b) ? 0 : 1;
            if (aIsDirect !== bIsDirect) return aIsDirect - bIsDirect;
            
            // Priority 2: Fewer contributing packages (closer to changed packages)
            const aContributing = (a as any).contributingPackages?.length || a.contributingPackagesCount || 1;
            const bContributing = (b as any).contributingPackages?.length || b.contributingPackagesCount || 1;
            if (aContributing !== bContributing) return aContributing - bContributing;
            
            // Priority 3: Higher duration as tiebreaker
            return b.duration - a.duration;
          })
          .slice(0, 200); // Top 200
        
        if (sortedActions.length === 0) {
          markdown += `*No actions found for this package.*\n`;
        } else {
          markdown += `**Top ${Math.min(sortedActions.length, 200)} Actions by Proximity to Changed Packages:**\n\n`;
          markdown += `| Rank | Target | Mnemonic | Duration (s) | Contributing Packages | Type |\n`;
          markdown += `|------|--------|----------|--------------|----------------------|------|\n`;
          
          sortedActions.forEach((action, index) => {
            const isDirect = hotspot.directActions.includes(action);
            const actionType = isDirect ? 'Direct' : 'Transitive';
            const contributingCount = (action as any).contributingPackages?.length || action.contributingPackagesCount || 1;
            markdown += `| ${index + 1} | \`${action.target}\` | ${action.mnemonic} | ${(action.duration / 1000).toFixed(3)} | ${contributingCount} | ${actionType} |\n`;
          });
          
          const directCount = hotspot.directActions.length;
          const transitiveCount = hotspot.transitiveActions.length;
          markdown += `\n*${directCount} direct actions, ${transitiveCount} transitive actions*\n`;
        }
      });
    }

    return markdown;
  }
}