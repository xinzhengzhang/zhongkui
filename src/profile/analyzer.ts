import { readFile } from 'fs/promises';
import { BazelAction } from '../types';
import { logger } from '../utils/logger';

interface ProfileEvent {
  name: string;
  cat: string;
  ph: string;
  ts: number;
  dur?: number;
  pid: number;
  tid: number;
  args?: any;
}

interface ProfileData {
  traceEvents: ProfileEvent[];
  displayTimeUnit?: string;
  otherData?: any;
}

/**
 * Analyzes Bazel profile JSON files to extract action timing data
 */
export class ProfileAnalyzer {
  /**
   * Analyze action timing data from a Bazel profile JSON file
   */
  async analyzeProfile(profilePath: string, targetPattern?: string): Promise<BazelAction[]> {
    logger.info(`Analyzing Bazel profile: ${profilePath}${targetPattern ? `, targets: ${targetPattern}` : ''}`);
    
    try {
      const profileData = await this.loadProfileData(profilePath);
      const actions = this.extractActionsFromProfile(profileData);
      
      if (targetPattern) {
        return this.filterActionsByTarget(actions, targetPattern);
      }
      
      return actions;
    } catch (error) {
      logger.error(`Failed to analyze profile ${profilePath}:`, error);
      throw error;
    }
  }

  /**
   * Load profile data from JSON file
   */
  private async loadProfileData(profilePath: string): Promise<ProfileData> {
    const content = await readFile(profilePath, 'utf-8');
    return JSON.parse(content);
  }

  /**
   * Extract action information from profile trace events
   */
  private extractActionsFromProfile(profileData: ProfileData): BazelAction[] {
    const actions: BazelAction[] = [];
    
    // Bazel profile events we're interested in:
    // - Categories that represent actual action executions
    // - Events with "ph": "X" are complete events with duration
    const actionCategories = [
      'action processing',
      'complete action execution',
      'local action execution',
      'action processing'
    ];
    
    const actionEvents = profileData.traceEvents.filter(event => 
      actionCategories.includes(event.cat) && 
      event.ph === 'X' && 
      event.dur !== undefined
    );

    for (const event of actionEvents) {
      try {
        const action = this.parseActionEvent(event);
        if (action) {
          actions.push(action);
        }
      } catch (error) {
        logger.warn(`Failed to parse action event:`, error);
      }
    }

    logger.info(`Extracted ${actions.length} actions from profile`);
    
    // Debug: log all unique targets/packages from profile
    const allTargets = [...new Set(actions.map(a => a.target))];
    const allPackages = [...new Set(actions.map(a => this.extractPackageFromTarget(a.target)))];
    logger.info(`Profile contains targets: ${allTargets.slice(0, 10).join(', ')}${allTargets.length > 10 ? ` (and ${allTargets.length - 10} more)` : ''}`);
    logger.info(`Profile contains packages: ${allPackages.join(', ')}`);
    
    return actions;
  }

  /**
   * Parse a single action event into BazelAction
   */
  private parseActionEvent(event: ProfileEvent): BazelAction | null {
    // Extract target information from event name or args
    // Event name formats vary, but typically include target info:
    // - "//path/to/package:target_name"  
    // - "SomeAction //path/to/package:target_name"
    // - "action '//path/to/package:target_name'"
    
    const target = this.extractTargetFromEvent(event);
    if (!target) {
      return null;
    }

    // Convert microseconds to milliseconds
    const duration = Math.round((event.dur || 0) / 1000);
    const startTime = Math.round(event.ts / 1000);
    
    // Extract inputs and outputs from args if available
    const inputs: string[] = [];
    const outputs: string[] = [];
    
    if (event.args) {
      if (event.args.inputs) {
        inputs.push(...this.parseFileList(event.args.inputs));
      }
      if (event.args.outputs) {
        outputs.push(...this.parseFileList(event.args.outputs));
      }
    }

    return {
      id: `${target}_${startTime}`, // Generate unique ID
      target,
      mnemonic: this.extractMnemonic(event),
      duration,
      startTime,
      endTime: startTime + duration,
      inputs,
      outputs
    };
  }

  /**
   * Extract target label from profile event
   */
  private extractTargetFromEvent(event: ProfileEvent): string | null {
    // Priority 1: Use args.target if available (most reliable)
    if (event.args && event.args.target) {
      return event.args.target;
    }

    // Priority 2: Check other args fields
    if (event.args) {
      if (event.args.label) {
        return event.args.label;
      }
      if (event.args.primaryOutput) {
        // Extract target from primary output path
        const match = event.args.primaryOutput.match(/\/\/([^:]+):/);
        if (match) {
          return `//${match[1]}:${event.args.primaryOutput.split(':').pop()}`;
        }
      }
    }

    // Priority 3: Extract from event name
    // Pattern 1: "ActionType //path/to/package:target"
    let match = event.name.match(/\/\/([^:\s]+:[^\s]+)/);
    if (match) {
      return match[0];
    }
    
    // Priority 4: Fallback - infer from file path in event name
    // Example: "KotlinNativePrebuild examples/di-example/di-full-example/di_full_example/..."
    const nameParts = event.name.split(' ');
    if (nameParts.length > 1 && event.args?.mnemonic) {
      const filePath = nameParts[1];
      // Try to extract package from file path
      const packageMatch = filePath.match(/^([^\/]+(?:\/[^\/]+)*)/);
      if (packageMatch) {
        const pathParts = packageMatch[1].split('/');
        // For paths like "examples/di-example/di-full-example/..."
        // Use the first 2-3 path components as package
        const packageDepth = Math.min(pathParts.length, 3);
        const potentialPackage = pathParts.slice(0, packageDepth).join('/');
        return `//${potentialPackage}:${event.args.mnemonic}`;
      }
    }

    return null;
  }

  /**
   * Extract action mnemonic from event
   */
  private extractMnemonic(event: ProfileEvent): string {
    // Priority 1: Use args.mnemonic if available (most reliable)
    if (event.args && event.args.mnemonic) {
      return event.args.mnemonic;
    }

    // Priority 2: Extract from event name - typically the first word
    const parts = event.name.split(' ');
    if (parts.length > 0 && !parts[0].startsWith('//')) {
      return parts[0];
    }

    return 'Unknown';
  }

  /**
   * Parse file list from profile args
   */
  private parseFileList(fileList: any): string[] {
    if (Array.isArray(fileList)) {
      return fileList.map(f => f.toString());
    }
    
    if (typeof fileList === 'string') {
      return fileList.split(',').map(f => f.trim());
    }

    return [];
  }

  /**
   * Filter actions based on target pattern
   */
  private filterActionsByTarget(actions: BazelAction[], targetPattern: string): BazelAction[] {
    logger.info(`Filtering ${actions.length} actions by target pattern: ${targetPattern}`);
    
    const regex = this.convertPatternToRegex(targetPattern);
    const filteredActions = actions.filter(action => regex.test(action.target));
    
    // Debug: show which actions matched and which didn't
    logger.info(`${filteredActions.length} actions matched target pattern`);
    if (filteredActions.length > 0) {
      logger.info(`Matched action targets: ${filteredActions.map(a => a.target).slice(0, 5).join(', ')}${filteredActions.length > 5 ? ` (and ${filteredActions.length - 5} more)` : ''}`);
    }
    
    if (filteredActions.length < actions.length) {
      const unmatched = actions.filter(action => !regex.test(action.target));
      logger.info(`${unmatched.length} actions did not match. Examples: ${unmatched.map(a => a.target).slice(0, 3).join(', ')}`);
    }
    
    return filteredActions;
  }

  /**
   * Convert Bazel target pattern to regex
   */
  private convertPatternToRegex(pattern: string): RegExp {
    // Escape special regex characters except * and ...
    let regexPattern = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')  // Escape special chars
      .replace(/\\\.\\\.\\\./g, '.*')         // ... becomes .*
      .replace(/\\\*/g, '[^:]*');             // * becomes [^:]*
    
    // Ensure exact match
    regexPattern = `^${regexPattern}$`;
    
    logger.info(`Target pattern '${pattern}' converted to regex: ${regexPattern}`);
    
    return new RegExp(regexPattern);
  }

  /**
   * Extract package path from a Bazel target
   */
  private extractPackageFromTarget(target: string): string {
    if (target.startsWith('//')) {
      const colonIndex = target.indexOf(':');
      return colonIndex > 0 ? target.slice(2, colonIndex) : target.slice(2);
    }
    return target;
  }

  /**
   * Get profile metadata for analysis context
   */
  async getProfileMetadata(profilePath: string): Promise<{
    totalActions: number;
    totalDuration: number;
    buildTime: number;
    profileVersion?: string;
    invocationId?: string;
  }> {
    const profileData = await this.loadProfileData(profilePath);
    const actions = this.extractActionsFromProfile(profileData);
    
    const totalDuration = actions.reduce((sum, action) => sum + action.duration, 0);
    
    // Find build start and end times
    const startTimes = actions.map(a => a.startTime || 0);
    const endTimes = actions.map(a => a.endTime || 0);
    
    const buildStart = Math.min(...startTimes);
    const buildEnd = Math.max(...endTimes);
    const buildTime = buildEnd - buildStart;

    // Extract invocation ID from profile metadata
    const invocationId = this.extractInvocationId(profileData);

    return {
      totalActions: actions.length,
      totalDuration,
      buildTime,
      profileVersion: profileData.otherData?.version,
      invocationId
    };
  }
  
  /**
   * Extract invocation ID from profile data
   */
  private extractInvocationId(profileData: ProfileData): string | undefined {
    // Method 1: Look for build_id in otherData (most reliable)
    if (profileData.otherData?.build_id) {
      return profileData.otherData.build_id;
    }
    
    // Method 2: Look in otherData for other potential IDs
    if (profileData.otherData?.invocationId) {
      return profileData.otherData.invocationId;
    }
    
    // Method 3: Look in metadata events
    const metadataEvents = profileData.traceEvents.filter(e => 
      e.name && (e.name.includes('InvocationPolicy') || e.name.includes('invocation'))
    );
    
    for (const event of metadataEvents) {
      if (event.args?.invocationId) {
        return event.args.invocationId;
      }
    }
    
    // Method 4: Look for command line events that might contain build request ID
    const cmdEvents = profileData.traceEvents.filter(e => 
      e.name && e.name.includes('command') && e.args
    );
    
    for (const event of cmdEvents) {
      if (event.args?.buildRequestId || event.args?.requestId) {
        return event.args.buildRequestId || event.args.requestId;
      }
    }
    
    // Method 5: Generate one from profile characteristics if not found
    // Use profile creation time or first action timestamp
    if (profileData.traceEvents.length > 0) {
      const firstEvent = profileData.traceEvents[0];
      return `profile_${Math.floor(firstEvent.ts / 1000000)}`; // Convert to seconds and use as ID
    }
    
    return undefined;
  }
}