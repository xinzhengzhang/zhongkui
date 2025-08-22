import { Command } from 'commander';
import { ProfileAnalyzer } from './profile/analyzer';
import { DiffAnalyzer } from './diff/analyzer';
import { SimpleDependencyAnalyzer } from './dependency/simple-analyzer';
import { HotspotReporter } from './hotspot/reporter';
import { logger } from './utils/logger';

const program = new Command();

program
  .name('zhongkui')
  .description('Analyze build hotspots in Bazel monorepos')
  .version('1.0.0');

program
  .command('analyze')
  .description('Analyze build performance from a Bazel profile')
  .requiredOption('-p, --profile <path>', 'Path to Bazel profile JSON file')
  .requiredOption('-t, --targets <pattern>', 'Build targets pattern (e.g., "//src/..." or "//app:*")')
  .option('-r, --repo-root <path>', 'Repository root path', process.cwd())
  .option('-b, --base-branch <branch>', 'Base branch for git diff comparison', 'origin/master')
  .action(async (options) => {
    try {
      logger.info(`Starting analysis for profile: ${options.profile}, targets: ${options.targets}`);
      
      // Analyze profile data - get ALL actions first, don't filter by targets yet
      const profileAnalyzer = new ProfileAnalyzer();
      const allActions = await profileAnalyzer.analyzeProfile(options.profile);
      
      // Get profile metadata for context
      const metadata = await profileAnalyzer.getProfileMetadata(options.profile);
      logger.info(`Profile contains ${metadata.totalActions} total actions`);
      
      // Analyze file changes
      const diffAnalyzer = new DiffAnalyzer(options.repoRoot);
      const fileChanges = await diffAnalyzer.analyzeChanges(options.repoRoot, options.baseBranch);
      
      // Simplified dependency analysis
      const dependencyAnalyzer = new SimpleDependencyAnalyzer(options.repoRoot);
      const analysis = await dependencyAnalyzer.analyze(allActions, fileChanges, options.targets);
      
      // Set analysis metadata
      analysis.profileId = `profile_${Date.now()}`;
      
      // Generate report
      const reporter = new HotspotReporter();
      await reporter.generateReport(analysis);
      
      logger.info('Analysis completed successfully');
    } catch (error) {
      logger.error('Analysis failed:', error);
      process.exit(1);
    }
  });

if (require.main === module) {
  program.parse();
}

export { program };