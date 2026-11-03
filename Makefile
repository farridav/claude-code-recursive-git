# The Claude Code release the checks run on. Bump it when a new release
# changes the mod API, after `make check test` pass locally on that release.
CLAUDE_CODE_VERSION ?= 2.1.317
PLUGIN := multi-repo
VERSION ?=

.PHONY: help deps check test smoke typecheck version package

help: ## List the targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F ':.*## ' '{printf "  %-10s %s\n", $$1, $$2}'

deps: ## Install the Claude Code CLI the checks run on
	npm install --global @anthropic-ai/claude-code@$(CLAUDE_CODE_VERSION)

check: ## Validate the manifest, the marketplace and the hooks module
	claude plugin validate .

test: ## Run the tests in tests/ against the engine
	claude plugin test .

smoke: ## Scan a scratch workspace of real git repos (needs git and Node 22.6+)
	node --experimental-strip-types --no-warnings scripts/smoke.ts

typecheck: ## Type-check; needs the types Claude Code writes into .claude-plugin/types/ when it loads the mod
	@test -d .claude-plugin/types || (echo "Run 'claude --plugin-dir .' once so Claude Code writes .claude-plugin/types/" && exit 1)
	npx --yes --package typescript@5.6 tsc -p .

version: ## Set the plugin's version: make version VERSION=1.2.3
	@test -n "$(VERSION)" || (echo "usage: make version VERSION=1.2.3" && exit 1)
	jq --arg version "$(VERSION)" '.version = $$version' .claude-plugin/plugin.json > .claude-plugin/plugin.json.tmp
	mv .claude-plugin/plugin.json.tmp .claude-plugin/plugin.json

package: ## Zip the mod as dist/multi-repo-v<version>.plugin
	@mkdir -p dist
	@version=$$(jq -r .version .claude-plugin/plugin.json) && \
		rm -f dist/$(PLUGIN)-v$$version.plugin && \
		zip -q -r dist/$(PLUGIN)-v$$version.plugin .claude-plugin/plugin.json hooks types LICENSE README.md && \
		echo dist/$(PLUGIN)-v$$version.plugin
