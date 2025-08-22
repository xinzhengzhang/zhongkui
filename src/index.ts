import { Command } from 'commander';
import { ProfileAnalyzer } from './profile/analyzer';
import { DiffAnalyzer } from './diff/analyzer';
import { SimpleDependencyAnalyzer } from './dependency/simple-analyzer';
import { HotspotReporter } from './hotspot/reporter';
import { logger, enableVerbose } from './utils/logger';
import { spawn } from 'child_process';
import { mkdtemp, rm } from 'fs/promises';
import { join, resolve, isAbsolute } from 'path';
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
function executeCommandWithLog(command: string, args: string[], cwd: string, logFilePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    logger.info(`Executing: ${command} ${args.join(' ')}`);
    
    // Print colorful message about log file
    console.log(`\n${colors.bright}${colors.cyan}📋 Bazel build output will be logged to:${colors.reset}`);
    console.log(`${colors.bright}${colors.green}   ${logFilePath}${colors.reset}`);
    console.log(`\n${colors.bright}${colors.yellow}💡 To monitor build progress in real-time, run:${colors.reset}`);
    console.log(`${colors.bright}${colors.blue}   tail -f ${logFilePath}${colors.reset}\n`);
    
    // Create write streams for the log file
    const logStream = createWriteStream(logFilePath, { flags: 'w' });
    
    const child = spawn(command, args, {
      cwd,
      stdio: ['inherit', 'pipe', 'pipe']
    });
    
    // Redirect stdout and stderr to log file
    child.stdout?.pipe(logStream);
    child.stderr?.pipe(logStream);
    
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
 */
function parseBazelCommand(bazelCommand: string) {
  const parts = bazelCommand.trim().split(/\s+/);
  
  let bazelBinary = 'bazel';
  let startupOpts: string[] = [];
  let command = '';
  let targets: string[] = [];
  let commandOpts: string[] = [];
  
  let i = 0;
  
  // Parse bazel binary (could be bazelisk, bazel, or a path)
  if (parts[i] && (parts[i].includes('bazel') || parts[i].startsWith('./'))) {
    bazelBinary = parts[i];
    i++;
  }
  
  // Parse startup options (before the command)
  while (i < parts.length && parts[i].startsWith('--') && !['build', 'test', 'run'].includes(parts[i])) {
    startupOpts.push(parts[i]);
    i++;
    // Handle options with values
    if (i < parts.length && !parts[i].startsWith('--')) {
      startupOpts[startupOpts.length - 1] += `=${parts[i]}`;
      i++;
    }
  }
  
  // Parse command (build, test, run, etc.)
  if (i < parts.length) {
    command = parts[i];
    i++;
  }
  
  // Parse remaining arguments - separate targets from options
  while (i < parts.length) {
    const arg = parts[i];
    if (arg.startsWith('--')) {
      // This is a command option
      commandOpts.push(arg);
      i++;
      // Handle options with values (consume the next argument as the value)
      if (i < parts.length && !parts[i].startsWith('--')) {
        commandOpts[commandOpts.length - 1] += `=${parts[i]}`;
        i++;
      }
    } else if (arg.startsWith('//') || (arg.startsWith('@') && arg.includes('//'))) {
      // This is a Bazel target (more specific check to avoid option values)
      targets.push(arg);
      i++;
    } else {
      // Skip unknown arguments
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
  
  // Debug logging to verify parsing
  logger.info(`Parsed command: ${JSON.stringify(result, null, 2)}`);
  
  return result;
}

/**
 * Execute analyze command with extracted options
 */
async function executeAnalyze(options: {
  profile: string;
  targets: string;
  repoRoot: string;
  baseBranch: string;
  outputDir: string;
  bazelBinary: string;
  startupOpts?: string;
  commandOpts?: string;
  cacheMode: string;
}) {
  logger.info(`Starting analysis for profile: ${options.profile}, targets: ${options.targets}`);
  
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
  
  // Analyze file changes
  const diffAnalyzer = new DiffAnalyzer(options.repoRoot);
  const fileChanges = await diffAnalyzer.analyzeChanges(options.repoRoot, options.baseBranch);
  
  // Simplified dependency analysis
  const dependencyAnalyzer = new SimpleDependencyAnalyzer(options.repoRoot);
  const analysis = await dependencyAnalyzer.analyze(
    allActions, 
    fileChanges, 
    options.targets, 
    {
      bazelBinary: options.bazelBinary,
      startupOpts: options.startupOpts,
      commandOpts: options.commandOpts,
      cacheMode: options.cacheMode as 'force' | 'auto'
    }
  );
  
  // Set analysis metadata
  analysis.profileId = `profile_${Date.now()}`;
  
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
  .version('1.0.0');

program
  .command('analyze')
  .description('Analyze build performance from a Bazel profile')
  .requiredOption('-p, --profile <path>', 'Path to Bazel profile JSON file')
  .requiredOption('-t, --targets <pattern>', 'Build targets pattern (e.g., "//src/..." or "//app:*")')
  .option('-r, --repo-root <path>', 'Repository root path', process.env.BUILD_WORKSPACE_DIRECTORY || process.cwd())
  .option('-b, --base-branch <branch>', 'Base branch for git diff comparison', 'origin/master')
  .option('-o, --output-dir <path>', 'Output directory for reports', 'report/')
  .option('--bazel-binary <path>', 'Path to bazel binary', 'bazel')
  .option('--startup-opts <opts>', 'Bazel startup options (e.g., "--host_jvm_args=-Xmx4g")')
  .option('--command-opts <opts>', 'Bazel command options (e.g., "--config=remote")')
  .option('--cache-mode <mode>', 'Dependency cache mode: "force" (ignore cache), "auto" (use cache if available)', 'auto')
  .option('--verbose', 'Enable verbose logging')
  .action(async (options) => {
    try {
      if (options.verbose) {
        enableVerbose();
      }
      await executeAnalyze(options);
    } catch (error) {
      logger.error('Analysis failed:', error);
      process.exit(1);
    }
  });

program
  .command('run-and-analyze')
  .description('Execute a Bazel command with profiling and automatically analyze the results')
  .requiredOption('-c, --command <bazel-command>', 'Complete Bazel command to execute (e.g., "bazel build //src:app --config=remote")')
  .option('-r, --repo-root <path>', 'Repository root path', process.env.BUILD_WORKSPACE_DIRECTORY || process.cwd())
  .option('-b, --base-branch <branch>', 'Base branch for git diff comparison', 'origin/master')
  .option('-o, --output-dir <path>', 'Output directory for reports', 'report/')
  .option('--cache-mode <mode>', 'Dependency cache mode: "force" (ignore cache), "auto" (use cache if available)', 'auto')
  .option('--keep-profile', 'Keep the generated profile file after analysis')
  .option('--verbose', 'Enable verbose logging')
  .action(async (options) => {
    let tempProfilePath: string | null = null;
    let logFilePath: string | null = null;
    
    try {
      if (options.verbose) {
        enableVerbose();
      }
      
      logger.info(`Executing Bazel command: ${options.command}`);
      
      // Parse the Bazel command
      const parsed = parseBazelCommand(options.command);
      logger.info(`Parsed command - Binary: ${parsed.bazelBinary}, Targets: ${parsed.targets}`);
      
      // Create temporary profile file
      const tempDir = await mkdtemp(join(tmpdir(), 'zhongkui-profile-'));
      tempProfilePath = join(tempDir, 'profile.json');
      
      // Create log file path
      logFilePath = join(tempDir, 'bazel-build.log');
      
      // Construct the modified Bazel command with profiling
      let profileArgs = [];
      if (parsed.startupOpts) {
        profileArgs.push(...parsed.startupOpts.split(/\s+/).filter(arg => arg));
      }
      profileArgs.push(parsed.command);
      profileArgs.push(`--profile=${tempProfilePath}`);
      if (parsed.commandOpts) {
        profileArgs.push(...parsed.commandOpts.split(/\s+/).filter(arg => arg));
      }
      profileArgs.push(...parsed.targets.split(/\s+/).filter(arg => arg));
      
      // Execute the Bazel command with profiling and log file output
      await executeCommandWithLog(parsed.bazelBinary, profileArgs, options.repoRoot, logFilePath);
      
      logger.info(`Profile generated at: ${tempProfilePath}`);
      
      // Now analyze the generated profile
      await executeAnalyze({
        profile: tempProfilePath,
        targets: parsed.targets,
        repoRoot: options.repoRoot,
        baseBranch: options.baseBranch,
        outputDir: options.outputDir,
        bazelBinary: parsed.bazelBinary,
        startupOpts: parsed.startupOpts,
        commandOpts: parsed.commandOpts,
        cacheMode: options.cacheMode as 'force' | 'auto'
      });
      
      // Clean up temporary files unless --keep-profile is specified
      if (!options.keepProfile && tempProfilePath) {
        logger.info('Cleaning up temporary profile and log files');
        await rm(tempProfilePath, { force: true });
        if (logFilePath) {
          await rm(logFilePath, { force: true });
        }
        // Only remove the temp directory, not recursively (to avoid deleting report files)
        try {
          await rm(join(tempProfilePath, '..'), { force: true });
        } catch (error) {
          // Ignore error if directory is not empty (contains other files)
          logger.debug('Temp directory cleanup skipped (may contain other files)');
        }
      } else if (options.keepProfile) {
        console.log(`${colors.bright}${colors.cyan}📁 Files kept:${colors.reset}`);
        console.log(`${colors.bright}${colors.green}   Profile: ${tempProfilePath}${colors.reset}`);
        if (logFilePath) {
          console.log(`${colors.bright}${colors.green}   Log:     ${logFilePath}${colors.reset}`);
        }
      }
      
    } catch (error) {
      logger.error('Run and analyze failed:', error);
      
      // Clean up on error unless --keep-profile is specified
      if (!options.keepProfile && tempProfilePath) {
        try {
          await rm(tempProfilePath, { force: true });
          if (logFilePath) {
            await rm(logFilePath, { force: true });
          }
          // Only remove the temp directory, not recursively
          try {
            await rm(join(tempProfilePath, '..'), { force: true });
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

if (require.main === module) {
  program.parse();
}

export { program };