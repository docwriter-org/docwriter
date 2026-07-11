#!/usr/bin/env bash
set -euo pipefail

target="${1:-all}"

if ! command -v fly >/dev/null 2>&1; then
	echo "fly CLI not found. Install it first: https://fly.io/docs/flyctl/install/"
	exit 1
fi

# App names are pinned in the fly config files (`app = ...`), so no --app flag.
deploy_runner() {
	echo "Deploying runner from fly.runner.toml"
	fly deploy --config fly.runner.toml
}

deploy_app() {
	echo "Deploying app from fly.toml"
	fly deploy --config fly.toml
}

case "${target}" in
	runner)
		deploy_runner
		;;
	app)
		deploy_app
		;;
	all)
		deploy_runner
		deploy_app
		;;
	*)
		echo "Usage: $0 [app|runner|all]"
		exit 2
		;;
esac
