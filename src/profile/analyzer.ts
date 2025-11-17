import { readFile } from 'fs/promises';
import { createReadStream } from 'fs';
import { createGunzip } from 'zlib';
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
   * Load profile data from JSON file (supports both .json and .gz files)
   */
  private async loadProfileData(profilePath: string): Promise<ProfileData> {
    // Check if file is gzip compressed
    if (profilePath.endsWith('.gz')) {
      return this.loadGzipProfileData(profilePath);
    }

    const content = await readFile(profilePath, 'utf-8');
    return JSON.parse(content);
  }

  /**
   * Load profile data from gzip compressed file
   */
  private async loadGzipProfileData(gzipPath: string): Promise<ProfileData> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const gunzip = createGunzip();

      createReadStream(gzipPath)
        .pipe(gunzip)
        .on('data', (chunk) => chunks.push(chunk))
        .on('end', () => {
          try {
            const content = Buffer.concat(chunks).toString('utf-8');
            const data = JSON.parse(content);
            resolve(data);
          } catch (error) {
            reject(error);
          }
        })
        .on('error', reject);
    });
  }

  /**
   * Extract action information from profile trace events
   * Uses a two-tier approach:
   * 1. 'action processing' events provide target info and act as parent events
   * 2. 'local action execution' and 'complete action execution' provide actual timing data
   */
  private extractActionsFromProfile(profileData: ProfileData): BazelAction[] {
    const actions: BazelAction[] = [];
    
    // Step 1: Extract parent events for target information
    const parentEvents = profileData.traceEvents.filter(event =>
      event.cat === 'action processing' &&
      event.ph === 'X' &&
      event.dur !== undefined &&
      event.dur > 0
    );
    
    // Step 2: Extract child events for actual timing
    const childCategories = ['local action execution', 'complete action execution'];
    const childEvents = profileData.traceEvents.filter(event =>
      childCategories.includes(event.cat) &&
      event.ph === 'X' &&
      event.dur !== undefined &&
      event.dur > 0
    );
    
    logger.info(`Found ${parentEvents.length} parent events (action processing) and ${childEvents.length} child events (execution)`);
    
    // Step 3: Build parent-child relationships
    const parentChildMap = this.buildParentChildMap(parentEvents, childEvents);
    
    // Step 4: Create BazelAction objects from child events
    for (const childEvent of childEvents) {
      try {
        const parentEvent = parentChildMap.get(childEvent);
        const action = this.parseActionEventWithParent(childEvent, parentEvent);
        if (action) {
          actions.push(action);
        }
      } catch (error) {
        logger.warn(`Failed to parse child action event:`, error);
      }
    }

    logger.info(`Extracted ${actions.length} fine-grained actions from profile`);
    
    // Debug: log all unique targets/packages from profile
    const allTargets = [...new Set(actions.map(a => a.target))];
    const allPackages = [...new Set(actions.map(a => this.extractPackageFromTarget(a.target)))];
    logger.info(`Profile contains targets: ${allTargets.slice(0, 10).join(', ')}${allTargets.length > 10 ? ` (and ${allTargets.length - 10} more)` : ''}`);
    logger.info(`Profile contains packages: ${allPackages.join(', ')}`);
    
    return actions;
  }

  /**
   * Build mapping from child events to their parent events
   * A parent contains a child if:
   * - parent.ts <= child.ts
   * - parent.ts + parent.dur >= child.ts + child.dur  
   * - parent.tid == child.tid
   */
  private buildParentChildMap(parentEvents: ProfileEvent[], childEvents: ProfileEvent[]): Map<ProfileEvent, ProfileEvent | null> {
    const parentChildMap = new Map<ProfileEvent, ProfileEvent | null>();
    
    for (const childEvent of childEvents) {
      let bestParent: ProfileEvent | null = null;
      let smallestDuration = Infinity;
      
      // Find the smallest parent that contains this child event
      for (const parentEvent of parentEvents) {
        if (this.isParentContainsChild(parentEvent, childEvent)) {
          // If multiple parents contain the child, choose the one with smallest duration (most specific)
          if (parentEvent.dur! < smallestDuration) {
            bestParent = parentEvent;
            smallestDuration = parentEvent.dur!;
          }
        }
      }
      
      parentChildMap.set(childEvent, bestParent);
      
      if (!bestParent) {
        logger.debug(`No parent found for child event: ${childEvent.name} (${childEvent.cat})`);
      }
    }
    
    const childrenWithParents = Array.from(parentChildMap.values()).filter(p => p !== null).length;
    logger.info(`Successfully mapped ${childrenWithParents}/${childEvents.length} child events to parent events`);
    
    return parentChildMap;
  }

  /**
   * Check if parent event contains child event based on timing and thread
   */
  private isParentContainsChild(parent: ProfileEvent, child: ProfileEvent): boolean {
    // Must be on same thread
    if (parent.tid !== child.tid) {
      return false;
    }
    
    const parentStart = parent.ts;
    const parentEnd = parent.ts + (parent.dur || 0);
    const childStart = child.ts;
    const childEnd = child.ts + (child.dur || 0);
    
    // Parent must completely contain child
    return parentStart <= childStart && parentEnd >= childEnd;
  }

  /**
   * Parse a child action event using parent event for target information
   */
  private parseActionEventWithParent(childEvent: ProfileEvent, parentEvent: ProfileEvent | null): BazelAction | null {
    // Try to get target from parent first (most reliable), then fall back to child
    const target = this.extractTargetFromEventWithFallback(parentEvent, childEvent);
    if (!target) {
      return null;
    }

    // Use child event's timing data (this is what we want for attribution)
    const duration = Math.round((childEvent.dur || 0) / 1000);
    const startTime = Math.round(childEvent.ts / 1000);

    // Generate unique ID that includes both parent and child info
    const parentInfo = parentEvent ? `_p${Math.round(parentEvent.ts / 1000)}` : '';
    const id = `${target}_${startTime}${parentInfo}`;

    return {
      id,
      target,
      mnemonic: this.extractMnemonicWithFallback(parentEvent, childEvent),
      duration, // This is from child event - the actual execution time we care about
      startTime,
      endTime: startTime + duration,
      // Additional metadata to track the source
      category: childEvent.cat,
      parentCategory: parentEvent?.cat
    };
  }

  /**
   * Extract target with fallback from parent to child event
   */
  private extractTargetFromEventWithFallback(parentEvent: ProfileEvent | null, childEvent: ProfileEvent): string | null {
    // Try parent first (action processing events have reliable target info)
    if (parentEvent) {
      const parentTarget = this.extractTargetFromEvent(parentEvent);
      if (parentTarget) {
        return parentTarget;
      }
    }
    
    // Fall back to child event
    return this.extractTargetFromEvent(childEvent);
  }

  /**
   * Extract mnemonic with fallback from parent to child event
   */
  private extractMnemonicWithFallback(parentEvent: ProfileEvent | null, childEvent: ProfileEvent): string {
    // Try parent first
    if (parentEvent) {
      const parentMnemonic = this.extractMnemonic(parentEvent);
      if (parentMnemonic !== 'Unknown') {
        return parentMnemonic;
      }
    }
    
    // Fall back to child event
    return this.extractMnemonic(childEvent);
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