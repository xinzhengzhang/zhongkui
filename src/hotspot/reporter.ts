import { writeFile } from 'fs/promises';
import { BuildAnalysis, PackageHotspot } from '../types';
import { logger } from '../utils/logger';

/**
 * Generates reports for build hotspots and performance analysis
 */
export class HotspotReporter {
  /**
   * Generate a comprehensive report for a single build analysis
   */
  async generateReport(analysis: BuildAnalysis): Promise<void> {
    logger.info(`Generating report for profile: ${analysis.profileId}`);

    const report = {
      profileId: analysis.profileId,
      timestamp: new Date().toISOString(),
      summary: this.generateSummary(analysis),
      hotspots: analysis.packageHotspots,
      fileChanges: analysis.fileChanges,
      impactedActions: analysis.impactedActions.length,
      recommendations: this.generateRecommendations(analysis.packageHotspots)
    };

    const fileName = `report-${analysis.profileId}-${Date.now()}.json`;
    await writeFile(fileName, JSON.stringify(report, null, 2));
    
    // Also generate human-readable report
    const humanReport = this.generateHumanReadableReport(report);
    const humanFileName = `report-${analysis.profileId}-${Date.now()}.md`;
    await writeFile(humanFileName, humanReport);

    logger.info(`Reports generated: ${fileName}, ${humanFileName}`);
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
  private generateHumanReadableReport(report: any): string {
    const { summary, hotspots, recommendations } = report;
    
    let markdown = `# Build Hotspot Analysis Report

**Profile ID:** ${report.profileId}
**Generated:** ${report.timestamp}

## Summary

- **Total Packages Analyzed:** ${summary.totalPackages}
- **Total Build Duration:** ${(summary.totalDuration / 1000).toFixed(2)}s
- **Average Package Duration:** ${(summary.averagePackageDuration / 1000).toFixed(2)}s
- **Impacted Actions:** ${report.impactedActions}

## Top 10 Package Hotspots

| Rank | Package | Duration (s) | Actions | Avg Duration (s) | % of Total |
|------|---------|-------------|---------|------------------|------------|
`;

    hotspots.slice(0, 10).forEach((hotspot: PackageHotspot, index: number) => {
      const percentage = (hotspot.totalDuration / summary.totalDuration * 100).toFixed(2);
      markdown += `| ${index + 1} | \`${hotspot.packagePath}\` | ${(hotspot.totalDuration / 1000).toFixed(2)} | ${hotspot.actionCount} | ${(hotspot.averageDuration / 1000).toFixed(2)} | ${percentage}% |\n`;
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

    return markdown;
  }
}