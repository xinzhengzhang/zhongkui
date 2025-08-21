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
}

export interface BuildAnalysis {
  profileId: string; // Changed from invocationId to profileId
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
  dependencies: string[];
  dependents: string[];
  actions: BazelAction[];
  impactWeight: number; // Weight in impact attribution
}