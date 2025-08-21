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
    // - Category "action" events represent individual action executions
    // - Events with "ph": "X" are complete events with duration
    const actionEvents = profileData.traceEvents.filter(event => 
      event.cat === 'action' && 
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
    // Try different patterns to extract target
    const patterns = [
      /\/\/[^:\s]+:[^\s]+/,  // Match //path/to/package:target
      /(@\w+)?\/\/[^:\s]+:[^\s]+/,  // Match external repo targets
    ];

    for (const pattern of patterns) {
      const match = event.name.match(pattern);
      if (match) {
        return match[0];
      }
    }

    // Try extracting from args
    if (event.args && event.args.target) {
      return event.args.target;
    }

    return null;
  }

  /**
   * Extract action mnemonic from event
   */
  private extractMnemonic(event: ProfileEvent): string {
    // Try to extract mnemonic from event name
    // Examples: "CppCompile", "Javac", "GoCompile"
    
    if (event.args && event.args.mnemonic) {
      return event.args.mnemonic;
    }

    // Extract from event name - typically the first word
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
    return actions.filter(action => regex.test(action.target));
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
    
    return new RegExp(regexPattern);
  }

  /**
   * Get profile metadata for analysis context
   */
  async getProfileMetadata(profilePath: string): Promise<{
    totalActions: number;
    totalDuration: number;
    buildTime: number;
    profileVersion?: string;
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

    return {
      totalActions: actions.length,
      totalDuration,
      buildTime,
      profileVersion: profileData.otherData?.version
    };
  }
}