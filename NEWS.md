# Release Notes - 钟馗 (Zhongkui)

- v0.0.5
- v0.0.4
- v0.0.3
- v0.0.2
- v0.0.1

## 🔧 v0.0.5 - Build Logging & Code Optimization

### ✨ New Features
- **Custom Log File Path**: New `-l, --logfile` option for `run-and-analyze` command
  - Specify custom path for generated build log files instead of temporary files
  - Relative paths resolved to repository root directory
  - Enables log persistence and custom organization
  - Automatic directory creation for specified log file paths

### 🛠 Improvements
- **ProfileEvent Optimization**: Streamlined profile parsing for better performance
  - Removed unused `inputs` and `outputs` fields from ProfileEvent type
  - Added filtering to exclude zero-duration events from analysis
  - Reduced memory footprint for large profile files
  - Improved parsing efficiency by focusing on actionable timing data
- **Code Cleanup**: Enhanced codebase maintainability
  - Removed unused functions from profile analyzer
  - Fixed `changedPackages` length calculation in hotspot reporter
  - Cleaner and more efficient codebase

### 🛠 Technical Details
- Enhanced CLI argument processing for custom log file paths with proper validation
- Optimized ProfileEvent interface by removing non-essential fields
- Improved profile parsing pipeline to skip irrelevant zero-duration events
- Better error handling for custom log file directory creation

### 💡 Usage Examples
```bash
# Use custom log file path
zhongkui run-and-analyze -c "bazel build //app:*" -l "./logs/build-$(date +%Y%m%d).log"

# Combined with other options
zhongkui run-and-analyze \
  -c "bazel build //app:* --config=release" \
  -p "./profiles/profile-$(git rev-parse --short HEAD).json" \
  -l "./logs/build-$(git rev-parse --short HEAD).log" \
  --exclude-packages "genfiles,external_deps"
```

**Impact**: Better build log management with custom paths and improved performance through optimized profile parsing.

## 🎯 v0.0.4 - Advanced Filtering & Granular Analysis

### ✨ New Features
- **Package Exclusion System**: New `--exclude-packages` option for filtering out noise from analysis
  - Exclude specified packages from attribution analysis (e.g., "genfiles,build-metadata")
  - Supports comma-separated list of package names
  - Useful for filtering out generated files and build metadata packages
- **Ignore File Support**: New `--ignore-file` option with smart defaults
  - Custom ignore file path specification (default: `.zhongkuiignore` in repo root)
  - Automatically excludes files matching patterns in ignore file from analysis
  - Git-style pattern matching for flexible file exclusion
- **Custom Profile Path**: New `-p, --profile` option for `run-and-analyze` command
  - Specify custom path for generated profile files instead of temporary files
  - Relative paths resolved to repository root directory
  - Enables profile persistence and custom organization

### 🔧 Improvements
- **Granular Profile Analysis**: Enhanced profile parsing for more detailed action breakdown
  - More precise action categorization and timing analysis
  - Improved metadata extraction from Bazel profile events
  - Better handling of complex build graphs with multiple dependencies
- **Memory Safety**: Added graceful error handling for JSON.stringify memory errors
  - Prevents crashes when processing very large profile files
  - Improved stability for memory-constrained environments
  - Better error messages for troubleshooting large dataset issues

### 🛠 Technical Details
- Enhanced file change filtering with dual exclusion system (ignore file + CLI parameter)
- Improved path resolution for custom profile files relative to repository root
- Added comprehensive error handling for large data serialization
- Optimized profile parsing pipeline for better performance and accuracy

### 💡 Usage Examples
```bash
# Exclude generated packages from analysis
zhongkui run-and-analyze -c "bazel build //app:*" --exclude-packages "genfiles,proto_gen,build_metadata"

# Use custom ignore file location
zhongkui run-and-analyze -c "bazel build //app:*" --ignore-file "./custom.ignore"

# Save profile to specific location
zhongkui run-and-analyze -c "bazel build //app:*" -p "./profiles/build-$(date +%Y%m%d).json"

# Combined advanced usage
zhongkui run-and-analyze \
  -c "bazel build //app:* --config=release" \
  -p "./analysis/profile-$(git rev-parse --short HEAD).json" \
  --exclude-packages "genfiles,external_deps" \
  --ignore-file "./.build-ignore"
```

**Impact**: More precise analysis by filtering out noise, custom profile management, and improved reliability for large-scale builds.

## 🚀 v0.0.3 - Enhanced CLI & Output Control

### ✨ New Features
- **Real-time Output Redirection**: New `--redirect-stdio` option for `run-and-analyze` command
  - Enables real-time viewing of Bazel build output directly in terminal
  - Maintains log file creation for later analysis
  - Improved user experience for monitoring long builds
- **Build Output Optimization**: Enhanced Bazel command execution with optimization flags
  - `--curses=no`: Cleaner output without terminal control sequences
  - `--color=yes`: Colored output for better readability
  - `--noprogress_in_terminal_title`: Prevents terminal title pollution

### 🔄 Changed  
- **Dual Output Mode**: Build commands now support both real-time display and log file preservation
- **Improved User Messaging**: Better feedback about output modes and log file locations
- **Command Structure**: Optimization flags are properly positioned in Bazel command options

### 🛠 Technical Details
- Enhanced `executeCommandWithLog()` function with stdio redirection capability
- Added proper stream piping for both stdout and stderr to current process
- Maintained backward compatibility with existing log-only behavior
- Correct parameter positioning in Bazel command construction

### 💡 Usage Examples
```bash
# Real-time output with log file backup
zhongkui run-and-analyze --redirect-stdio -c "bazel build //app:*"

# Traditional log-only mode (default)
zhongkui run-and-analyze -c "bazel build //app:*"
```

**Impact**: Users can now monitor build progress in real-time while still maintaining comprehensive log files for analysis.

## 🔧 v0.0.2 - Bug Fixes & Improvements

### 🐛 Fixed
- **Time Calculation Logic**: Fixed incorrect time attribution in package hotspot analysis
  - `actualTime` now correctly shows only direct actions time (actions executed directly in the package)
  - `transitiveTime` now correctly shows transitive actions time (actions caused by package changes but executed elsewhere)
  - Previously, `actualTime` incorrectly included both direct and transitive actions, while `transitiveTime` was always 0
- **Report Consistency**: Fixed inconsistency between `changedPackagesAnalysis` and `hotspots` time calculations
- **Analyzer Alignment**: Applied consistent time calculation logic across both `SimpleDependencyAnalyzer` and `DependencyAnalyzer`

### 🔄 Changed  
- **Time Attribution Semantics**: Clarified the meaning of time fields in reports:
  - `actualTime`: Time spent on actions directly in this package due to changes
  - `transitiveTime`: Time spent on actions caused by this package's changes but executed in other packages
  - This provides clearer insight into where build time is actually being spent

### 🛠 Technical Details
- Updated `SimpleDependencyAnalyzer.calculatePackageStats()` with correct time separation logic
- Updated `DependencyAnalyzer.calculatePackageHotspots()` with proper field initialization
- Fixed `HotspotReporter.generateChangedPackagesAnalysis()` fallback calculations
- All analyzers now consistently populate `actualCompilationTime` and `transitiveCompilationTime` fields

**Impact**: Reports now accurately show the breakdown of build time, making it easier to identify optimization opportunities.

## 🎉 Initial Release

We're excited to announce the first release of **钟馗 (Zhongkui)** - a powerful local build performance analysis tool for Bazel monorepos.

## ✨ Key Features

### Core Analysis Capabilities
- **Bazel Profile Analysis**: Parse Chrome Tracing format JSON files generated by `bazel build --profile=profile.json`
- **Git Diff Integration**: Analyze file changes to identify affected Bazel packages
- **Dependency Correlation**: Advanced attribution logic that maps build time to responsible packages
- **Pure Local Operation**: Works entirely offline without requiring BEP infrastructure

### Three Analysis Modes

#### 1. Profile Analysis (`analyze`)
Analyze existing Bazel profile files with detailed timing data:
```bash
zhongkui analyze -p profile.json -c "bazel build //app:* --config=release"
```

#### 2. Run & Analyze (`run-and-analyze`) 
Execute Bazel commands with profiling and automatic analysis:
```bash
zhongkui run-and-analyze -c "bazel build //src:..." --keep-profile
```

#### 3. Impact Prediction (`predict-impact`)
Static analysis to predict affected packages before building:
```bash
zhongkui predict-impact -c "bazel build //app:*" --base-branch origin/main
```

### Advanced Attribution Logic
- **Direct Attribution**: Actions in changed packages receive full duration attribution
- **Transitive Tracking**: Actions in dependent packages tracked without double-counting
- **Shared Dependencies**: Split attribution when multiple packages contribute to an action
- **Pure Attribution**: Total attributed time equals actual build time

### Multi-Repository Support
- **External Repositories**: Full support for Bazel 6+ Bzlmod format (`@@repo~//package`)
- **Additional Repos**: Analyze changes across multiple sub-repositories
- **Scoped Analysis**: Target pattern scoping to avoid irrelevant dependency analysis

## 🛠 Technical Highlights

### Architecture
- **Modular Design**: Clear separation between profile analysis, diff analysis, and dependency correlation
- **Bazel Query Integration**: Accurate target-to-package mapping using native Bazel queries
- **Performance Optimized**: Caching and incremental analysis for large monorepos

### Build System
- **Bazel + rules_js**: Modern build system with incremental compilation
- **TypeScript**: Full type safety with comprehensive type definitions
- **Node.js 20.6.0**: Latest LTS runtime managed by Bazel

### Output Formats
- **JSON Reports**: Machine-readable analysis results for data product integration
- **Markdown Reports**: Human-readable reports with actionable recommendations
- **Colorful CLI**: Enhanced terminal output with progress indicators

## 📊 Report Generation

### Analysis Reports
- `report-{profileId}-{timestamp}.json` - Complete analysis data
- `report-{profileId}-{timestamp}.md` - Formatted recommendations

### Prediction Reports  
- `impact-prediction-{profileId}-{timestamp}.json` - Static impact analysis
- `impact-prediction-{profileId}-{timestamp}.md` - Pre-build planning guide

## 🔧 Installation & Usage

### Prerequisites
- Bazel 6.0+
- Node.js 20.6.0
- Git repository

### Quick Start
```bash
# Build the tool
bazel build //src:zhongkui

# Generate profile and analyze
bazel run //src:zhongkui -- run-and-analyze -c "bazel build //your-targets..."

# Predict impact before building
bazel run //src:zhongkui -- predict-impact -c "bazel build //your-targets..."
```

## 🎯 Use Cases

- **Build Optimization**: Identify hotspots consuming the most build time
- **Change Impact Analysis**: Understand which packages are affected by code changes
- **Pre-build Planning**: Predict build impact before making changes
- **Performance Monitoring**: Track build performance over time across different branches

## 🙏 Acknowledgments

钟馗 is designed for teams working with large-scale Bazel monorepos who need actionable insights into their build performance without complex infrastructure dependencies.

---

**Full Changelog**: Initial release

**Compatibility**: Bazel 6.0+, Node.js 20.6.0+
