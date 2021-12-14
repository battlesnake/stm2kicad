#!/bin/bash

# Can't use "yarn --cwd stm2kicad start" as yarn will resolve symlinks in the
# path, breaking relative paths to the parent directory.

# So instead we have a bash script, which does no such bullshit.

set -e

declare selfdir="$(realpath "$(dirname "$0")")"

set -x

"$selfdir/node_modules/.bin/ts-node" --project "$selfdir"/tsconfig.json "$selfdir/extractor.ts" "$@"
