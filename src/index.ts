import { Command } from 'commander';
import { ProfileAnalyzer } from './profile/analyzer';
import { DiffAnalyzer } from './diff/analyzer';
import { DependencyAnalyzer } from './dependency/analyzer';
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
  .action(async (options) => {
    try {
      logger.info(`Starting analysis for profile: ${options.profile}, targets: ${options.targets}`);
      
      // Analyze profile data for specific targets
      const profileAnalyzer = new ProfileAnalyzer();
      const actions = await profileAnalyzer.analyzeProfile(options.profile, options.targets);
      
      // Get profile metadata for context
      const metadata = await profileAnalyzer.getProfileMetadata(options.profile);
      logger.info(`Profile contains ${metadata.totalActions} total actions, ${actions.length} matching targets`);
      
      // Analyze file changes
      const diffAnalyzer = new DiffAnalyzer();
      const fileChanges = await diffAnalyzer.analyzeChanges(options.repoRoot);
      
      // Analyze dependencies and calculate hotspots with target scope
      const dependencyAnalyzer = new DependencyAnalyzer(options.repoRoot);
      const analysis = await dependencyAnalyzer.analyze(actions, fileChanges, options.targets);
      
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