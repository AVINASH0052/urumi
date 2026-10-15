CLUSTER ?= urumi
NS      ?= urumi
RELEASE ?= urumi
ENV     ?= local
CHART   := charts/urumi
VALUES  := $(CHART)/values-$(ENV).yaml
TAG     ?= dev
APPS    := $(notdir $(patsubst %/Dockerfile,%,$(wildcard apps/*/Dockerfile)))

.PHONY: up cluster images import deps deploy status store-password admin-password credentials setup-logs lint nuke

up: cluster images import deploy        ## fresh laptop -> working platform

cluster:                                ## k3d cluster with host :80/:443 -> Traefik
	k3d cluster create --config k3d/cluster.yaml

images:                                 ## build every apps/*/Dockerfile (repo root is the build context)
	for a in $(APPS); do docker build -t urumi/$$a:$(TAG) -f apps/$$a/Dockerfile . || exit 1; done

import:                                 ## load local images into k3d (no registry needed)
	$(if $(APPS),k3d image import $(foreach a,$(APPS),urumi/$(a):$(TAG)) -c $(CLUSTER))

deps:
	helm dependency update $(CHART)

deploy: deps                            ## install/upgrade everything (LLM_API_KEY=... enables chat); waits for setup
	helm upgrade --install $(RELEASE) $(CHART) -n $(NS) --create-namespace \
	  -f $(VALUES) --wait --timeout 15m \
	  $(if $(LLM_API_KEY),--set platform.gateway.llm.apiKey=$(LLM_API_KEY))

status:
	kubectl -n $(NS) get pods,svc,ingress,pvc,netpol,secret

store-password:                         ## WordPress admin password
	@kubectl -n $(NS) get secret $(RELEASE)-store -o jsonpath='{.data.WP_ADMIN_PASSWORD}' | base64 -d; echo

credentials:                            ## every login for the demo, in one place
	@echo "Dashboard (gateway)  http://app.localtest.me"
	@echo "  user:     $$(kubectl -n $(NS) get deploy $(RELEASE)-gateway -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="BOOTSTRAP_ADMIN_EMAIL")].value}')"
	@echo "  password: $$(kubectl -n $(NS) get secret $(RELEASE)-gateway -o jsonpath='{.data.BOOTSTRAP_ADMIN_PASSWORD}' | base64 -d)"
	@echo "MCP endpoint         http://app.localtest.me/mcp   (Bearer <API key from Dashboard > My API keys>)"
	@echo "Storefront           http://store.localtest.me"
	@echo "WooCommerce admin    http://store.localtest.me/wp-admin"
	@echo "  user:     admin"
	@echo "  password: $$(kubectl -n $(NS) get secret $(RELEASE)-store -o jsonpath='{.data.WP_ADMIN_PASSWORD}' | base64 -d)"
	@echo "Internal secrets (never needed by people): kubectl -n $(NS) get secret $(RELEASE)-gateway $(RELEASE)-store"

admin-password:                         ## gateway dashboard password for the bootstrap admin
	@kubectl -n $(NS) get secret $(RELEASE)-gateway -o jsonpath='{.data.BOOTSTRAP_ADMIN_PASSWORD}' | base64 -d; echo

setup-logs:
	kubectl -n $(NS) logs job/$(RELEASE)-setup

lint: deps                              ## helm lint + schema validation for both environments
	helm lint charts/store
	helm lint charts/platform
	for e in local prod; do \
	  helm lint $(CHART) -f $(CHART)/values-$$e.yaml && \
	  helm template $(RELEASE) $(CHART) -n $(NS) -f $(CHART)/values-$$e.yaml | kubeconform -strict -summary || exit 1; \
	done

nuke:                                   ## delete the whole local cluster
	k3d cluster delete $(CLUSTER)
