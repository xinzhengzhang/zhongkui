import { Command } from 'commander';
import { ProfileAnalyzer } from './profile/analyzer';
import { DiffAnalyzer, AdditionalRepo } from './diff/analyzer';
import { SimpleDependencyAnalyzer } from './dependency/simple-analyzer';
import { HotspotReporter } from './hotspot/reporter';
import { logger, enableVerbose } from './utils/logger';
import { spawn } from 'child_process';
import { mkdtemp, rm, mkdir } from 'fs/promises';
import { join, resolve, isAbsolute, dirname } from 'path';
import { tmpdir } from 'os';
import { createWriteStream } from 'fs';

/**
 * ANSI color codes for terminal output
 */
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  blue: '\x1b[34m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m'
};

/**
 * Execute a command with output redirected to a log file
 */
function executeCommandWithLog(command: string, args: string[], cwd: string, logFilePath: string, redirectStdio: boolean = false): Promise<void> {
  return new Promise((resolve, reject) => {
    logger.info(`Executing: ${command} ${args.join(' ')}`);
    
    if (!redirectStdio) {
      // Print colorful message about log file only when not redirecting to stdio
      console.log(`\n${colors.bright}${colors.cyan}📋 Bazel build output will be logged to:${colors.reset}`);
      console.log(`${colors.bright}${colors.green}   ${logFilePath}${colors.reset}`);
      console.log(`\n${colors.bright}${colors.yellow}💡 To monitor build progress in real-time, run:${colors.reset}`);
      console.log(`${colors.bright}${colors.blue}   tail -f ${logFilePath}${colors.reset}\n`);
    } else {
      console.log(`\n${colors.bright}${colors.cyan}🔄 Bazel build output will be shown in real-time${colors.reset}`);
      console.log(`${colors.bright}${colors.green}📄 Build log will also be saved to: ${logFilePath}${colors.reset}\n`);
    }
    
    // Create write streams for the log file
    const logStream = createWriteStream(logFilePath, { flags: 'w' });
    
    const child = spawn(command, args, {
      cwd,
      stdio: ['inherit', 'pipe', 'pipe']
    });
    
    // Always write to log file
    child.stdout?.pipe(logStream);
    child.stderr?.pipe(logStream);
    
    // Additionally redirect to current stdio if requested
    if (redirectStdio) {
      child.stdout?.pipe(process.stdout);
      child.stderr?.pipe(process.stderr);
    }
    
    child.on('close', async (code) => {
      logStream.end();
      
      // Check for build results URLs in the last 10 lines of the log file
      try {
        const { readFile } = await import('fs/promises');
        const logContent = await readFile(logFilePath, 'utf8');
        const lines = logContent.trim().split('\n');
        const lastTenLines = lines.slice(-10);
        
        // Look for build results URLs (BuildBuddy, etc.)
        const urlPattern = /INFO:\s+Streaming build results to:\s+(https?:\/\/[^\s]+)/i;
        for (const line of lastTenLines) {
          const match = line.match(urlPattern);
          if (match) {
            console.log(`${colors.bright}${colors.cyan}🔗 Build results available at:${colors.reset}`);
            console.log(`${colors.bright}${colors.blue}   ${match[1]}${colors.reset}`);
          }
        }
      } catch (error) {
        // Ignore errors reading log file for URL extraction
        logger.debug('Failed to extract build results URL from log file:', error);
      }
      
      if (code === 0) {
        console.log(`${colors.bright}${colors.green}✅ Bazel command completed successfully${colors.reset}\n`);
        resolve();
      } else {
        console.log(`${colors.bright}${colors.yellow}❌ Bazel command failed with exit code ${code}${colors.reset}\n`);
        reject(new Error(`Command failed with exit code ${code}`));
      }
    });
    
    child.on('error', (error) => {
      logStream.end();
      reject(error);
    });
  });
}

/**
 * Parse a Bazel command to extract relevant options for analysis
 * Supports two modes:
 * 1. Separate: bazel --startup-opts command --command-opts targets
 * 2. Combined: "bazel --startup-opts" command --command-opts targets
 */
function parseBazelCommand(bazelCommand: string) {
  const parts = bazelCommand.trim().split(/\s+/);
  
  let bazelBinary = 'bazel';
  let startupOpts: string[] = [];
  let command = '';
  let targets: string[] = [];
  let commandOpts: string[] = [];
  
  let i = 0;
  
  // Parse bazel binary with potential startup options
  if (parts[i] && (parts[i].includes('bazel') || parts[i].startsWith('./') || parts[i].startsWith('/'))) {
    bazelBinary = parts[i];
    i++;
  }
  
  // Look ahead to find the command position
  let commandIndex = -1;
  for (let j = i; j < parts.length; j++) {
    if (['build', 'test', 'run', 'query', 'cquery', 'info', 'version'].includes(parts[j])) {
      commandIndex = j;
      command = parts[j];
      break;
    }
  }
  
  // If no command found, assume 'build'
  if (commandIndex === -1) {
    command = 'build';
    commandIndex = parts.length; // Treat rest as targets/options
  }
  
  // Decide parsing strategy - always use separate mode for clarity
  // Parse startup options separately (before the command)
  while (i < commandIndex) {
    const arg = parts[i];
    
    if (arg.startsWith('--')) {
      if (arg.includes('=')) {
        // Option with value in same arg: --output_base=/tmp/path
        startupOpts.push(arg);
      } else {
        // Option may have value in next arg: --output_base /tmp/path
        startupOpts.push(arg);
        // Check if next arg is a value (not starting with -- and not a command)
        if (i + 1 < commandIndex && !parts[i + 1].startsWith('--') && 
            !['build', 'test', 'run', 'query', 'cquery', 'info', 'version'].includes(parts[i + 1])) {
          i++;
          startupOpts[startupOpts.length - 1] += `=${parts[i]}`;
        }
      }
      i++;
    } else {
      // Not a startup option and not a command, warn and skip
      logger.warn(`Unexpected argument before command: ${arg}`);
      i++;
    }
  }
  
  // Parse remaining arguments after command - separate targets from options
  i = commandIndex + 1;
  while (i < parts.length) {
    const arg = parts[i];
    
    if (arg.startsWith('--')) {
      // This is a command option
      if (arg.includes('=')) {
        // Option with value: --config=release
        commandOpts.push(arg);
        i++;
      } else {
        // Option may have value in next arg, but be careful not to consume targets or other options
        commandOpts.push(arg);
        i++;
        
        // Check if next arg is a value for this option
        if (i < parts.length && !parts[i].startsWith('--') && !parts[i].startsWith('//')) {
          // Only consume the next argument if it looks like a value, not a target
          // This is heuristic-based - if it contains special characters, likely a value
          const nextArg = parts[i];
          if (nextArg.includes('=') || nextArg.includes(':') || nextArg.includes('/') || 
              /^[a-zA-Z0-9_-]+$/.test(nextArg)) {
            commandOpts[commandOpts.length - 1] += `=${nextArg}`;
            i++;
          }
        }
      }
    } else if (arg.startsWith('//') || (arg.startsWith('@') && arg.includes('//'))) {
      // This is a Bazel target
      targets.push(arg);
      i++;
    } else {
      // Skip unknown arguments
      logger.debug(`Skipping unknown argument: ${arg}`);
      i++;
    }
  }
  
  const result = {
    bazelBinary,
    startupOpts: startupOpts.join(' '),
    command,
    targets: targets.length > 0 ? targets.join(' ') : '//...',
    commandOpts: commandOpts.join(' ')
  };
  
  // Debug logging to verify parsing - make it more visible
  logger.info(`\n=== BAZEL COMMAND PARSING ===`);
  logger.info(`Original command: ${bazelCommand}`);
  logger.info(`Parsed components:`);
  logger.info(`  - bazelBinary: "${result.bazelBinary}"`);
  logger.info(`  - startupOpts: "${result.startupOpts}"`);
  logger.info(`  - command: "${result.command}"`);
  logger.info(`  - targets: "${result.targets}"`);
  logger.info(`  - commandOpts: "${result.commandOpts}"`);
  logger.info(`===============================\n`);
  
  return result;
}

/**
 * Parse additional repository specification with optional repo names
 * Supports formats:
 * - "path" -> {path: "path", repoName: null}
 * - "path:reponame" -> {path: "path", repoName: "reponame"}
 */
function parseAdditionalRepoSpec(spec: string): { path: string; repoName: string | null } {
  const parts = spec.split(':');
  if (parts.length === 2) {
    return { path: parts[0].trim(), repoName: parts[1].trim() };
  } else {
    return { path: parts[0].trim(), repoName: null };
  }
}

/**
 * Resolve additional repository paths relative to the repo root
 */
function resolveAdditionalRepos(additionalReposString: string | undefined, repoRoot: string): Array<{ path: string; repoName: string | null }> {
  if (!additionalReposString) return [];
  
  return additionalReposString.split(',').map((spec: string) => {
    const parsed = parseAdditionalRepoSpec(spec);
    const resolvedPath = isAbsolute(parsed.path) ? parsed.path : resolve(repoRoot, parsed.path);
    return {
      path: resolvedPath,
      repoName: parsed.repoName
    };
  });
}

/**
 * Execute predict-impact analysis - static analysis of potentially affected actions
 */
async function executePredictImpact(options: {
  command: string;
  repoRoot: string;
  baseBranch: string;
  outputDir: string;
  cacheMode: string;
  additionalRepos?: AdditionalRepo[];
  verbose?: boolean;
}) {
  logger.info(`Predicting impact for command: ${options.command}`);
  
  // Parse the Bazel command to extract targets
  const parsed = parseBazelCommand(options.command);
  logger.info(`Parsed command - Binary: ${parsed.bazelBinary}, Targets: ${parsed.targets}`);
  
  // Resolve output directory relative to repo root if it's a relative path
  const absoluteOutputDir = isAbsolute(options.outputDir) 
    ? options.outputDir 
    : resolve(options.repoRoot, options.outputDir);
  
  // Additional repos should already be resolved at this point
  const resolvedAdditionalRepos = options.additionalRepos || [];
  
  // Analyze file changes in the main repository and additional repos
  const diffAnalyzer = new DiffAnalyzer(options.repoRoot, resolvedAdditionalRepos);
  const fileChanges = await diffAnalyzer.analyzeChanges(options.repoRoot, options.baseBranch);
  
  logger.info(`Found ${fileChanges.length} changed files across ${new Set(fileChanges.map(fc => fc.package)).size} packages`);
  
  // Extract changed packages
  const changedPackages = [...new Set(fileChanges.map(fc => fc.package))];
  
  // Use BazelQuery directly to build dependency graph
  const bazelQuery = new (await import('./bazel/query')).BazelQuery(options.repoRoot);
  const dependencyGraph = await bazelQuery.buildDependencyGraph(parsed.targets, {
    bazelBinary: parsed.bazelBinary,
    startupOpts: parsed.startupOpts,
    commandOpts: parsed.commandOpts,
    cacheMode: options.cacheMode as 'force' | 'auto'
  });
  
  // Find potentially affected packages using dependency graph
  const potentiallyAffectedPackages = new Map<string, { reason: string; contributingPackages: string[] }>();
  
  // Add directly changed packages
  for (const pkg of changedPackages) {
    potentiallyAffectedPackages.set(pkg, {
      reason: 'direct change',
      contributingPackages: []
    });
  }
  
  // Find packages that transitively depend on changed packages
  const maxDepth = 3;
  for (const changedPkg of changedPackages) {
    const transitiveDependents = bazelQuery.getTransitiveDependentsFromGraph(
      [changedPkg], 
      dependencyGraph, 
      maxDepth
    );
    
    const dependents = transitiveDependents.get(changedPkg) || new Set();
    for (const dependentPkg of dependents) {
      if (!potentiallyAffectedPackages.has(dependentPkg)) {
        potentiallyAffectedPackages.set(dependentPkg, {
          reason: 'transitive dependency',
          contributingPackages: [changedPkg]
        });
      } else {
        // Add to contributing packages if it's already there due to multiple changed packages
        const existing = potentiallyAffectedPackages.get(dependentPkg)!;
        if (!existing.contributingPackages.includes(changedPkg)) {
          existing.contributingPackages.push(changedPkg);
        }
      }
    }
  }
  
  // Generate prediction report
  const timestamp = new Date().toISOString();
  const profileId = `predict_${Date.now()}`;
  
  const predictionReport = {
    type: 'impact-prediction',
    profileId,
    timestamp,
    command: options.command,
    parsedCommand: parsed,
    baseBranch: options.baseBranch,
    summary: {
      totalChangedFiles: fileChanges.length,
      totalChangedPackages: changedPackages.length,
      totalPotentiallyAffectedPackages: potentiallyAffectedPackages.size,
      analysisScope: parsed.targets
    },
    fileChanges,
    potentiallyAffectedPackages: Array.from(potentiallyAffectedPackages.entries()).map(([packagePath, info]) => ({
      packagePath,
      reason: info.reason,
      contributingPackages: info.contributingPackages
    })),
    recommendations: [
      `${potentiallyAffectedPackages.size} packages may be affected by changes`,
      fileChanges.length > 10 ? 'Consider using more targeted builds with specific target patterns' : 'Change scope appears manageable',
      'Run the actual build with profiling to get precise timing data'
    ]
  };
  
  // Write JSON report
  const jsonFileName = join(absoluteOutputDir, `impact-prediction-${profileId}-${Date.now()}.json`);
  await import('fs/promises').then(fs => fs.mkdir(absoluteOutputDir, { recursive: true }));
  await import('fs/promises').then(fs => fs.writeFile(jsonFileName, JSON.stringify(predictionReport, null, 2)));
  
  // Generate markdown report
  const markdownReport = generatePredictionMarkdownReport(predictionReport, {
    repoRoot: options.repoRoot,
    baseBranch: options.baseBranch,
    outputDir: options.outputDir,
    cacheMode: options.cacheMode,
    verbose: options.verbose
  });
  const mdFileName = join(absoluteOutputDir, `impact-prediction-${profileId}-${Date.now()}.md`);
  await import('fs/promises').then(fs => fs.writeFile(mdFileName, markdownReport));
  
  // Display prediction results with highlighted colors
  console.log(`\n${colors.bright}${colors.cyan}🔮 Impact prediction completed:${colors.reset}`);
  console.log(`${colors.bright}${colors.green}   JSON: ${jsonFileName}${colors.reset}`);
  console.log(`${colors.bright}${colors.green}   MD:   ${mdFileName}${colors.reset}`);
  console.log(`\n${colors.bright}${colors.yellow}📊 Prediction Summary:${colors.reset}`);
  console.log(`   Changed files: ${predictionReport.summary.totalChangedFiles}`);
  console.log(`   Changed packages: ${predictionReport.summary.totalChangedPackages}`);
  console.log(`   Potentially affected packages: ${predictionReport.summary.totalPotentiallyAffectedPackages}\n`);
  
  logger.info('Impact prediction completed successfully');
}

/**
 * Generate markdown report for impact prediction
 */
function generatePredictionMarkdownReport(report: any, options: {
  repoRoot: string;
  baseBranch: string;
  outputDir: string;
  cacheMode: string;
  verbose?: boolean;
}): string {
  let markdown = `# Build Impact Prediction Report

**Profile ID:** ${report.profileId}
**Generated:** ${report.timestamp}
**Command:** \`${report.command}\`
**Base Branch:** ${report.baseBranch}

## Prediction Summary

- **Changed Files:** ${report.summary.totalChangedFiles}
- **Changed Packages:** ${report.summary.totalChangedPackages}
- **Potentially Affected Packages:** ${report.summary.totalPotentiallyAffectedPackages}
- **Analysis Scope:** \`${report.summary.analysisScope}\`

## Changed Files

| File | Change Type | Package |
|------|-------------|---------|
`;

  report.fileChanges.forEach((fc: any) => {
    markdown += `| \`${fc.path}\` | ${fc.changeType} | \`${fc.package}\` |\n`;
  });

  markdown += `\n## Potentially Affected Packages

| Package | Reason | Contributing Changes |
|---------|--------|---------------------|
`;

  report.potentiallyAffectedPackages.forEach((pkg: any) => {
    const contributing = pkg.contributingPackages.length > 0 
      ? pkg.contributingPackages.map((p: string) => `\`${p}\``).join(', ')
      : 'Direct change';
    markdown += `| \`${pkg.packagePath}\` | ${pkg.reason} | ${contributing} |\n`;
  });

  if (report.recommendations && report.recommendations.length > 0) {
    markdown += `\n## Recommendations\n\n`;
    report.recommendations.forEach((rec: string, index: number) => {
      markdown += `${index + 1}. ${rec}\n`;
    });
  }

  markdown += `\n## Next Steps

1. **Review the potentially affected packages** to understand the scope of impact
2. **Establish baseline performance** by running: \`${report.command}\`  
3. **Make your code changes** based on the impact analysis above
4. **Measure actual performance impact** by running: \`zhongkui run-and-analyze -c "${report.command}" -r "${options.repoRoot}" -b "${options.baseBranch}" -o "${options.outputDir}" --cache-mode "${options.cacheMode}"${options.verbose ? ' --verbose' : ''}\`
5. **Compare results** to understand the real cost of your changes

---
*This is a static prediction based on dependency analysis. Run actual builds with profiling for precise timing data.*
`;

  return markdown;
}
async function executeAnalyze(options: {
  profile: string;
  command?: string;
  targets?: string;
  repoRoot: string;
  baseBranch: string;
  outputDir: string;
  bazelBinary?: string;
  startupOpts?: string;
  commandOpts?: string;
  cacheMode: string;
  additionalRepos?: AdditionalRepo[];
}) {
  let actualTargets: string;
  let actualBazelBinary: string;
  let actualStartupOpts: string = '';
  let actualCommandOpts: string = '';

  // Parse command or use provided options
  if (options.command) {
    logger.info(`Parsing Bazel command: ${options.command}`);
    const parsed = parseBazelCommand(options.command);
    
    actualTargets = parsed.targets;
    actualBazelBinary = parsed.bazelBinary;
    actualStartupOpts = parsed.startupOpts;
    actualCommandOpts = parsed.commandOpts;
    
    // Override with explicit options if provided (only if different from default)
    if (options.targets) {
      logger.info(`Overriding targets from command with explicit option: ${options.targets}`);
      actualTargets = options.targets;
    }
    // Only override bazel binary if explicitly provided (not the default value)
    if (options.bazelBinary && options.bazelBinary !== 'bazel') {
      logger.info(`Overriding bazel binary from command with explicit option: ${options.bazelBinary}`);
      actualBazelBinary = options.bazelBinary;
    }
    if (options.startupOpts) {
      actualStartupOpts = options.startupOpts;
    }
    if (options.commandOpts) {
      actualCommandOpts = options.commandOpts;
    }
    
    logger.info(`DEBUG: parsed.bazelBinary = "${parsed.bazelBinary}"`);
    logger.info(`DEBUG: actualBazelBinary after assignment = "${actualBazelBinary}"`);
    logger.info(`DEBUG: options.bazelBinary = "${options.bazelBinary || 'undefined'}"`);
    
    logger.info(`Using parsed values - Targets: ${actualTargets}, Binary: ${actualBazelBinary}`);
  } else {
    // Use provided options directly (backward compatibility)
    actualTargets = options.targets!;
    actualBazelBinary = options.bazelBinary || 'bazel';
    actualStartupOpts = options.startupOpts || '';
    actualCommandOpts = options.commandOpts || '';
  }

  logger.info(`Starting analysis for profile: ${options.profile}, targets: ${actualTargets}`);
  
  // Resolve output directory relative to repo root if it's a relative path
  const absoluteOutputDir = isAbsolute(options.outputDir) 
    ? options.outputDir 
    : resolve(options.repoRoot, options.outputDir);
  
  // Analyze profile data - get ALL actions first, don't filter by targets yet
  const profileAnalyzer = new ProfileAnalyzer();
  const allActions = await profileAnalyzer.analyzeProfile(options.profile);
  
  // Get profile metadata for context
  const metadata = await profileAnalyzer.getProfileMetadata(options.profile);
  logger.info(`Profile contains ${metadata.totalActions} total actions`);
  
  // Additional repos should already be resolved at this point
  const resolvedAdditionalRepos = options.additionalRepos || [];
  
  // Analyze file changes in the main repository and additional repos
  const diffAnalyzer = new DiffAnalyzer(options.repoRoot, resolvedAdditionalRepos);
  const fileChanges = await diffAnalyzer.analyzeChanges(options.repoRoot, options.baseBranch);
  
  // Simplified dependency analysis
  const dependencyAnalyzer = new SimpleDependencyAnalyzer(options.repoRoot);
  const analysis = await dependencyAnalyzer.analyze(
    allActions, 
    fileChanges, 
    actualTargets, 
    {
      bazelBinary: actualBazelBinary,
      startupOpts: actualStartupOpts,
      commandOpts: actualCommandOpts,
      cacheMode: options.cacheMode as 'force' | 'auto'
    }
  );
  
  // Set analysis metadata
  analysis.invocationId = metadata.invocationId;
  
  // Generate report using absolute output directory
  const reporter = new HotspotReporter();
  const reportPaths = await reporter.generateReport(analysis, absoluteOutputDir);
  
  // Display report paths with highlighted colors
  console.log(`\n${colors.bright}${colors.cyan}📄 Analysis reports generated:${colors.reset}`);
  console.log(`${colors.bright}${colors.green}   JSON: ${reportPaths.jsonPath}${colors.reset}`);
  console.log(`${colors.bright}${colors.green}   MD:   ${reportPaths.mdPath}${colors.reset}\n`);
  
  logger.info('Analysis completed successfully');
}

const program = new Command();

program
  .name('zhongkui')
  .description('Analyze build hotspots in Bazel monorepos')
  .version('0.0.3');

program
  .command('analyze')
  .description('Analyze build performance from a Bazel profile')
  .requiredOption('-p, --profile <path>', 'Path to Bazel profile JSON file')
  .option('-c, --command <bazel-command>', 'Complete Bazel command used to generate the profile (auto-extracts targets and options)')
  .option('-t, --targets <pattern>', 'Build targets pattern (e.g., "//src/..." or "//app:*") - required if --command is not provided')
  .option('-r, --repo-root <path>', 'Repository root path', process.env.BUILD_WORKSPACE_DIRECTORY || process.cwd())
  .option('-b, --base-branch <branch>', 'Base branch for git diff comparison', 'origin/master')
  .option('-o, --output-dir <path>', 'Output directory for reports', 'report/')
  .option('--additional-repos <paths>', 'Comma-separated paths to additional sub-bazel repositories to scan for changes. Format: "path" or "path:reponame" (e.g., "srcs/kntr:kntr_module,../shared:shared_lib")')
  .option('--bazel-binary <path>', 'Path to bazel binary', 'bazel')
  .option('--startup-opts <opts>', 'Bazel startup options (e.g., "--host_jvm_args=-Xmx4g")')
  .option('--command-opts <opts>', 'Bazel command options (e.g., "--experimental_profile_include_target_label=true")')
  .option('--cache-mode <mode>', 'Dependency cache mode: "force" (ignore cache), "auto" (use cache if available)', 'auto')
  .option('--verbose', 'Enable verbose logging')
  .addHelpText('after', `
Examples:
  # Method 1: Use complete command (recommended - auto-extracts everything)
  zhongkui analyze -p profile.json -c "bazel build //app:* --config=release"
  zhongkui analyze -p profile.json -c "./bazel-wrapper build --output_base=/tmp/bazel //src/..."

  # Method 2: Manual specification (legacy mode)
  zhongkui analyze -p profile.json -t "//app:*" --bazel-binary ./bazel-wrapper
  
  # With custom options and additional repositories
  zhongkui analyze -p profile.json -c "bazel build //app:*" -b origin/develop --additional-repos "srcs/kntr:kntr_module,../shared:shared_lib" --verbose`)
  .action(async (options) => {
    try {
      if (options.verbose) {
        enableVerbose();
      }
      
      // Parse and resolve additional repositories relative to repo-root
      const additionalRepos = resolveAdditionalRepos(options.additionalRepos, options.repoRoot);
      
      // Validate required parameters based on usage mode
      if (!options.command && !options.targets) {
        logger.error('Either --command or --targets is required');
        process.exit(1);
      }
      
      await executeAnalyze({
        ...options,
        additionalRepos
      });
    } catch (error) {
      logger.error('Analysis failed:', error);
      process.exit(1);
    }
  });

program
  .command('run-and-analyze')
  .description('Execute a Bazel command with profiling and automatically analyze the results')
  .requiredOption('-c, --command <bazel-command>', 'Complete Bazel command to execute (e.g., "bazel build //src:app")')
  .option('-r, --repo-root <path>', 'Repository root path', process.env.BUILD_WORKSPACE_DIRECTORY || process.cwd())
  .option('-b, --base-branch <branch>', 'Base branch for git diff comparison', 'origin/master')
  .option('-o, --output-dir <path>', 'Output directory for reports', 'report/')
  .option('--profile-path <path>', 'Custom path for the generated profile file (default: temporary file)')
  .option('--additional-repos <paths>', 'Comma-separated paths to additional sub-bazel repositories to scan for changes. Format: "path" or "path:reponame"')
  .option('--cache-mode <mode>', 'Dependency cache mode: "force" (ignore cache), "auto" (use cache if available)', 'auto')
  .option('--keep-profile', 'Keep the generated profile file after analysis')
  .option('--verbose', 'Enable verbose logging')
  .option('--redirect-stdio', 'Redirect Bazel command output to current stdout/stderr in addition to log file')
  .action(async (options) => {
    let profilePath: string;
    let logFilePath: string;
    let isCustomProfile = false; // Track if using custom profile path
    const tempDir = await mkdtemp(join(tmpdir(), 'zhongkui-profile-'));
    
    try {
      if (options.verbose) {
        enableVerbose();
      }
      
      // Parse and resolve additional repositories relative to repo-root
      const additionalRepos = resolveAdditionalRepos(options.additionalRepos, options.repoRoot);
      
      logger.info(`Executing Bazel command: ${options.command}`);
      
      // Parse the Bazel command
      const parsed = parseBazelCommand(options.command);
      logger.info(`Parsed command - Binary: ${parsed.bazelBinary}, Targets: ${parsed.targets}`);
      
      if (options.profilePath) {
        // Use custom profile path
        profilePath = resolve(options.profilePath);
        isCustomProfile = true;
        logger.info(`Using custom profile path: ${profilePath}`);
        
        // Ensure the directory exists
        const profileDir = dirname(profilePath);
        await mkdir(profileDir, { recursive: true });
      } else {
        // Create temporary profile file
        profilePath = join(tempDir, 'profile.json');
        logger.info(`Using temporary profile path: ${profilePath}`);
      }
      
      // Create log file path
      logFilePath = join(tempDir, 'bazel-build.log');
      
      // Construct the modified Bazel command with profiling
      let profileArgs = [];
      if (parsed.startupOpts) {
        profileArgs.push(...parsed.startupOpts.split(/\s+/).filter(arg => arg));
      }
      profileArgs.push(parsed.command);
      profileArgs.push(`--profile=${profilePath}`);
      if (parsed.commandOpts) {
        profileArgs.push(...parsed.commandOpts.split(/\s+/).filter(arg => arg));
      }
      // Add build optimization flags for better output
      profileArgs.push('--curses=no', '--color=yes', '--noprogress_in_terminal_title');
      profileArgs.push(...parsed.targets.split(/\s+/).filter(arg => arg));
      
      // Execute the Bazel command with profiling and log file output
      await executeCommandWithLog(parsed.bazelBinary, profileArgs, options.repoRoot, logFilePath, options.redirectStdio);
      
      logger.info(`Profile generated at: ${profilePath}`);
      
      // Now analyze the generated profile
      await executeAnalyze({
        profile: profilePath,
        targets: parsed.targets,
        repoRoot: options.repoRoot,
        baseBranch: options.baseBranch,
        outputDir: options.outputDir,
        bazelBinary: parsed.bazelBinary,
        startupOpts: parsed.startupOpts,
        commandOpts: parsed.commandOpts,
        cacheMode: options.cacheMode as 'force' | 'auto',
        additionalRepos
      });
      
      // Clean up temporary files unless --keep-profile is specified
      if (!options.keepProfile && !isCustomProfile && profilePath) {
        logger.info('Cleaning up temporary profile and log files');
        await rm(profilePath, { force: true });
        if (logFilePath) {
          await rm(logFilePath, { force: true });
        }
        // Only remove the temp directory, not recursively (to avoid deleting report files)
        try {
          await rm(join(profilePath, '..'), { force: true });
        } catch (error) {
          // Ignore error if directory is not empty (contains other files)
          logger.debug('Temp directory cleanup skipped (may contain other files)');
        }
      } else if (options.keepProfile || isCustomProfile) {
        console.log(`${colors.bright}${colors.cyan}📁 Files kept:${colors.reset}`);
        console.log(`${colors.bright}${colors.green}   Profile: ${profilePath}${colors.reset}`);
        if (logFilePath) {
          console.log(`${colors.bright}${colors.green}   Log:     ${logFilePath}${colors.reset}`);
        }
        if (isCustomProfile) {
          console.log(`${colors.bright}${colors.yellow}   Note: Using custom profile path (not cleaned up automatically)${colors.reset}`);
        }
      }
      
    } catch (error) {
      logger.error('Run and analyze failed:', error);
      
      // Clean up on error unless --keep-profile is specified or using custom profile
      if (!options.keepProfile && !isCustomProfile) {
        try {
          await rm(profilePath, { force: true });
          if (logFilePath) {
            await rm(logFilePath, { force: true });
          }
          // Only remove the temp directory, not recursively
          try {
            await rm(tempDir, { force: true });
          } catch (cleanupError) {
            // Ignore error if directory is not empty
          }
        } catch (cleanupError) {
          logger.warn('Failed to clean up temporary files:', cleanupError);
        }
      }
      
      process.exit(1);
    }
  });

program
  .command('predict-impact')
  .description('Predict which packages and actions might be affected by changes without running the build')
  .requiredOption('-c, --command <bazel-command>', 'Complete Bazel command to analyze (e.g., "bazel build //src:app")')
  .option('-r, --repo-root <path>', 'Repository root path', process.env.BUILD_WORKSPACE_DIRECTORY || process.cwd())
  .option('-b, --base-branch <branch>', 'Base branch for git diff comparison', 'origin/master')
  .option('-o, --output-dir <path>', 'Output directory for reports', 'report/')
  .option('--additional-repos <paths>', 'Comma-separated paths to additional sub-bazel repositories to scan for changes. Format: "path" or "path:reponame"')
  .option('--cache-mode <mode>', 'Dependency cache mode: "force" (ignore cache), "auto" (use cache if available)', 'auto')
  .option('--verbose', 'Enable verbose logging')
  .action(async (options) => {
    try {
      if (options.verbose) {
        enableVerbose();
      }
      
      // Parse and resolve additional repositories relative to repo-root
      const additionalRepos = resolveAdditionalRepos(options.additionalRepos, options.repoRoot);
      
      await executePredictImpact({
        ...options,
        additionalRepos
      });
    } catch (error) {
      logger.error('Impact prediction failed:', error);
      process.exit(1);
    }
  });

if (require.main === module) {
  program.parse();
}

export { program };