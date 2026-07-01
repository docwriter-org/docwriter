#!/usr/bin/env bash
set -euo pipefail

target="${1:-all}"
app_name="${DOCWRITER_FLY_APP:-docwriter-app}"
runner_name="${DOCWRITER_FLY_RUNNER_APP:-docwriter-runner}"

if ! command -v fly >/dev/null 2>&1; then
	echo "fly CLI not found. Install it first: https://fly.io/docs/flyctl/install/"
	exit 1
fi

deploy_runner() {
	echo "Deploying ${runner_name} from fly.runner.toml"
	fly deploy --config fly.runner.toml --app "${runner_name}"
}

deploy_app() {
	echo "Deploying ${app_name} from fly.toml"
	fly deploy --config fly.toml --app "${app_name}"
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
