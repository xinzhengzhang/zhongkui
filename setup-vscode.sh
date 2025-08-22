#!/bin/bash
# Setup node_modules symlink for VSCode IntelliSense

# Build the node_modules target
echo "Building node_modules..."
bazel build //:node_modules

# Find the node_modules directory using bazel info
BAZEL_BIN=$(bazel info bazel-bin)
NODE_MODULES_PATH="$BAZEL_BIN/node_modules"

if [ ! -d "$NODE_MODULES_PATH" ]; then
    echo "Error: Could not find node_modules directory at $NODE_MODULES_PATH"
    exit 1
fi

# Remove existing symlink if it exists
rm -f node_modules

# Create symlink
ln -sf "$NODE_MODULES_PATH" node_modules

echo "Created symlink: node_modules -> $NODE_MODULES_PATH"
echo "VSCode IntelliSense should now work!"