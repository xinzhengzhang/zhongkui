// Core types for Zhongkui build analysis

export interface BazelAction {
  id: string;
  target: string;
  mnemonic: string;
  duration: number;
  inputs: string[];
  outputs: string[];
  package?: string; // Resolved package path
  startTime?: number;
  endTime?: number;
  contributingPackagesCount?: number; // Number of changed packages that caused this action
  contributingPackages?: string[]; // List of changed packages that caused this action
  transitiveDepth?: number; // How many hops from changed packages
  category?: string; // Event category from profile (e.g., 'local action execution')
  parentCategory?: string; // Parent event category (e.g., 'action processing')
}

export interface FileChange {
  path: string;
  changeType: 'added' | 'modified' | 'deleted';
  package: string;
}

export interface PackageHotspot {
  packagePath: string;
  totalDuration: number;
  actionCount: number;
  averageDuration: number;
  impactedBuilds: number;
  directActions: BazelAction[]; // Actions directly in this package (time attributed here)
  transitiveActions: BazelAction[]; // Actions affected by this package's changes (time attributed to changed packages)
  contributingPackages: string[]; // Changed packages that caused transitive actions
  // Time breakdown for changed packages
  actualCompilationTime: number; // Real time spent compiling this changed package
  transitiveCompilationTime: number; // Time spent on dependencies due to changes
  attributionBreakdown: {
    [changedPackage: string]: {
      directTime: number; // Time from direct actions
      transitiveTime: number; // Time from transitive actions caused by this package
      actionCount: number; // Number of actions attributed to this package
    };
  };
}

export interface BuildAnalysis {
  invocationId?: string; // Bazel invocation ID for correlation
  fileChanges: FileChange[];
  impactedActions: BazelAction[];
  packageHotspots: PackageHotspot[];
  packageDependencyGraph: PackageDependencyGraph;
}

export interface PackageDependencyGraph {
  packages: Map<string, PackageNode>;
}

export interface PackageNode {
  packagePath: string;
  actions: BazelAction[];
  impactWeight: number; // Weight in impact attribution
}