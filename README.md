# 钟馗 (Zhongkui) - Bazel Build Performance Analyzer

> A powerful local build performance analysis tool for Bazel monorepos

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Bazel](https://img.shields.io/badge/Built%20with-Bazel-43A047.svg)](https://bazel.build/)
[![TypeScript](https://img.shields.io/badge/Built%20with-TypeScript-3178C6.svg)](https://www.typescriptlang.org/)

**钟馗 (Zhongkui)** identifies build hotspots in Bazel monorepos by analyzing profile data, git changes, and dependency graphs to provide actionable optimization insights - all running locally without external infrastructure.

## 🚀 Quick Start

```bash
# Build the tool
bazel build //src:zhongkui

# Analyze a build with real-time output
bazel run //src:zhongkui -- run-and-analyze --redirect-stdio -c "bazel build //your-targets..."

# Predict impact before building  
bazel run //src:zhongkui -- predict-impact -c "bazel build //your-targets..."
```

## ✨ Features

### 🎯 Three Analysis Modes

| Mode | Purpose | Command | Output |
|------|---------|---------|--------|
| **Profile Analysis** | Analyze existing profiles | `analyze` | Detailed timing reports |
| **Run & Analyze** | Build + analyze in one step | `run-and-analyze` | Complete workflow |
| **Impact Prediction** | Static analysis before building | `predict-impact` | Pre-build planning |

### 💡 Key Capabilities

- **🔍 Hotspot Identification**: Pinpoint packages consuming the most build time
- **🌳 Dependency Analysis**: Advanced attribution logic for shared dependencies  
- **📊 Multi-Format Reports**: JSON for automation, Markdown for humans
- **🏢 Monorepo Support**: Handle complex multi-repository setups
- **⚡ Real-time Output**: Stream build progress with `--redirect-stdio`
- **🔄 Pure Local**: No external infrastructure required

## 📋 Prerequisites

- **Bazel 6.0+** - Modern Bazel with Bzlmod support
- **Node.js 20.6.0** - Managed by Bazel rules_nodejs
- **Git repository** - For change analysis
- **POSIX environment** - macOS, Linux, or WSL on Windows

## 🛠 Installation & Setup

### Build from Source

```bash
# Clone the repository
git clone <repository-url>
cd zhongkui

# Build the tool
bazel build //src:zhongkui

# Verify installation
bazel run //src:zhongkui -- --version
# Output: 0.0.3
```

### Development Setup

```bash
# Setup VSCode IntelliSense (run when dependencies change)
./setup-vscode.sh

# Run tests (TODO: tests not yet implemented)
bazel test //...

```

## 📖 Usage Examples

### Basic Workflow

```bash
# Method 1: Run build with profiling and analyze results
bazel run //src:zhongkui -- run-and-analyze \
  -c "bazel build //app:* --config=release" \
  --base-branch origin/main

# Method 2: Analyze existing profile file
bazel run //src:zhongkui -- analyze \
  -p profile.json \
  -c "bazel build //app:*" \
  -r /path/to/repo
```

### Advanced Usage

```bash
# Real-time build monitoring
bazel run //src:zhongkui -- run-and-analyze \
  --redirect-stdio \
  --verbose \
  --keep-profile \
  -c "bazel test //app:* --config=ci"

# Multi-repository analysis  
bazel run //src:zhongkui -- run-and-analyze \
  -c "bazel build //app:*" \
  --additional-repos "libs:shared_libs,../common:common_utils"

# Impact prediction for planning
bazel run //src:zhongkui -- predict-impact \
  -c "bazel build //app:*" \
  --base-branch origin/develop \
  --verbose
```

### Command Options

#### Global Options
- `--verbose` - Enable detailed logging
- `--repo-root <path>` - Repository root path (default: current directory)
- `--base-branch <branch>` - Base branch for change comparison (default: `origin/master`)
- `--output-dir <path>` - Output directory for reports (default: `report/`)

#### run-and-analyze Specific
- `--redirect-stdio` - Show build output in real-time ⭐ **New in v0.0.3**
- `--keep-profile` - Preserve generated profile files
- `--cache-mode <mode>` - Dependency cache mode (`auto` | `force`)

## 📊 Report Formats

### Analysis Reports
- **JSON**: `report-{profileId}-{timestamp}.json` - Machine-readable data
- **Markdown**: `report-{profileId}-{timestamp}.md` - Human-readable insights

### Prediction Reports  
- **JSON**: `impact-prediction-{profileId}-{timestamp}.json` - Static analysis
- **Markdown**: `impact-prediction-{profileId}-{timestamp}.md` - Planning guide

### Sample Report Structure
```json
{
  "summary": {
    "totalBuildTime": 45000,
    "affectedPackages": 12,
    "topHotspots": [...]
  },
  "changedPackagesAnalysis": [...],
  "hotspots": [...],
  "recommendations": [...]
}
```

## 🏗 Architecture

### Core Components

```
src/
├── profile/     # Bazel profile JSON analysis  
├── bazel/       # Bazel query integration
├── diff/        # Git change analysis
├── dependency/  # Action-to-package correlation
├── hotspot/     # Report generation
├── utils/       # Shared utilities
├── types.ts     # Type definitions
└── index.ts     # CLI entry point
```

### Data Flow

1. **Profile Analysis** - Parse Bazel profile JSON files
2. **Change Detection** - Analyze git diff for affected packages  
3. **Dependency Mapping** - Correlate changes with build actions
4. **Attribution Logic** - Distribute build time across responsible packages
5. **Report Generation** - Create actionable insights

### Attribution Algorithm

- **Direct Attribution**: Actions in changed packages get full time attribution
- **Transitive Tracking**: Dependent actions recorded without double-counting
- **Shared Dependencies**: Split time among contributing packages
- **Pure Attribution**: Total attributed time equals actual build time

## 🔧 Configuration

### Bazel Integration
Zhongkui automatically adds optimization flags to build commands:
- `--curses=no` - Cleaner terminal output
- `--color=yes` - Colored build output  
- `--noprogress_in_terminal_title` - Clean terminal titles

### Multi-Repository Support
```bash
# Format: "path" or "path:reponame"
--additional-repos "libs:shared_libs,../common:common_utils"
```

## 🚦 Build System

This project uses **Bazel** with **rules_js** for modern JavaScript/TypeScript development:

- **Incremental Builds** - Only rebuild what changed
- **Remote Caching** - Share build artifacts across developers  
- **Deterministic Builds** - Reproducible builds across environments
- **Parallel Execution** - Optimal multi-core utilization

## 🤝 Contributing

We welcome contributions! Please see our development setup above.

### Development Commands
```bash
# Build and test
bazel build //...
bazel test //...  # TODO: tests not yet implemented

# Code quality
npm run lint:fix
npm run typecheck
```

## 📝 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

钟馗 is designed for teams working with large-scale Bazel monorepos who need actionable build performance insights without complex infrastructure dependencies.

---

**Repository**: [GitHub Repository URL]  
**Issues**: [GitHub Issues URL]  
**Documentation**: [See NEWS.md for detailed changelog](./NEWS.md)

Built with ❤️ for the Bazel community