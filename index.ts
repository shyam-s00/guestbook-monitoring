// Copyright 2016-2025, Pulumi Corporation.  All rights reserved.

import * as fs from "fs";
import * as path from "path";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

// Minikube does not implement services of type `LoadBalancer`; require the user to specify if we're
// running on minikube, and if so, create only services of type ClusterIP.
const config = new pulumi.Config();
const isMinikube = config.getBoolean("isMinikube") ?? true;
const grafanaAdminUser = config.get("grafanaAdminUser") || "admin";
const grafanaAdminPassword =
    config.getSecret("grafanaAdminPassword") || pulumi.secret("prom-operator");

//
// REDIS LEADER.
//

const redisLeaderLabels = { app: "redis-leader" };
const redisLeaderDeployment = new k8s.apps.v1.Deployment("redis-leader", {
    metadata: { labels: redisLeaderLabels },
    spec: {
        selector: { matchLabels: redisLeaderLabels },
        template: {
            metadata: { labels: redisLeaderLabels },
            spec: {
                containers: [
                    {
                        name: "redis-leader",
                        image: "redis",
                        resources: { requests: { cpu: "100m", memory: "100Mi" } },
                        ports: [{ containerPort: 6379 }],
                    },
                    {
                        name: "redis-exporter",
                        image: "oliver006/redis_exporter:v1.58.0",
                        resources: { requests: { cpu: "50m", memory: "64Mi" } },
                        ports: [{ name: "metrics", containerPort: 9121 }],
                    },
                ],
            },
        },
    },
});
const redisLeaderService = new k8s.core.v1.Service("redis-leader", {
    metadata: {
        name: "redis-leader",
        labels: redisLeaderDeployment.metadata.labels,
    },
    spec: {
        ports: [
            { name: "redis", port: 6379, targetPort: 6379 },
            { name: "metrics", port: 9121, targetPort: 9121 },
        ],
        selector: redisLeaderDeployment.spec.template.metadata.labels,
    },
});

//
// REDIS REPLICA.
//

const redisReplicaLabels = { app: "redis-replica" };
const redisReplicaDeployment = new k8s.apps.v1.Deployment("redis-replica", {
    metadata: { labels: redisReplicaLabels },
    spec: {
        selector: { matchLabels: redisReplicaLabels },
        template: {
            metadata: { labels: redisReplicaLabels },
            spec: {
                containers: [
                    {
                        name: "replica",
                        image: "pulumi/guestbook-redis-replica",
                        resources: { requests: { cpu: "100m", memory: "100Mi" } },
                        // If your cluster config does not include a dns service, then to instead access an environment
                        // variable to find the leader's host, change `value: "dns"` to read `value: "env"`.
                        env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
                        ports: [{ containerPort: 6379 }],
                    },
                    {
                        name: "redis-exporter",
                        image: "oliver006/redis_exporter:v1.58.0",
                        resources: { requests: { cpu: "50m", memory: "64Mi" } },
                        ports: [{ name: "metrics", containerPort: 9121 }],
                    },
                ],
            },
        },
    },
});
const redisReplicaService = new k8s.core.v1.Service("redis-replica", {
    metadata: {
        name: "redis-replica",
        labels: redisReplicaDeployment.metadata.labels,
    },
    spec: {
        ports: [
            { name: "redis", port: 6379, targetPort: 6379 },
            { name: "metrics", port: 9121, targetPort: 9121 },
        ],
        selector: redisReplicaDeployment.spec.template.metadata.labels,
    },
});

//
// FRONTEND
//

const frontendLabels = { app: "frontend" };
const frontendDeployment = new k8s.apps.v1.Deployment("frontend", {
    metadata: { labels: frontendLabels },
    spec: {
        selector: { matchLabels: frontendLabels },
        replicas: 3,
        template: {
            metadata: { labels: frontendLabels },
            spec: {
                containers: [
                    {
                        name: "frontend",
                        image: "pulumi/guestbook-php-redis",
                        resources: { requests: { cpu: "100m", memory: "100Mi" } },
                        // If your cluster config does not include a dns service, then to instead access an environment
                        // variable to find the master service's host, change `value: "dns"` to read `value: "env"`.
                        env: [{ name: "GET_HOSTS_FROM", value: "dns" /* value: "env"*/ }],
                        ports: [{ containerPort: 80 }],
                    },
                   {
                        name: "apache-exporter",
                        image: "quay.io/lusitaniae/apache-exporter",
                        args: ["--scrape_uri=http://localhost:80/server-status?auto"],
                        resources: { requests: { cpu: "50m", memory: "64Mi" } },
                        ports: [{ name: "metrics", containerPort: 9117 }],
                    },
                ],
            },
        },
    },
});
const frontendService = new k8s.core.v1.Service("frontend", {
    metadata: {
        labels: frontendDeployment.metadata.labels,
        name: "frontend",
    },
    spec: {
        type: isMinikube ? "ClusterIP" : "LoadBalancer",
        ports: [
            { name: "http", port: 80 },
            { name: "metrics", port: 9117, targetPort: 9117 },
        ],
        selector: frontendDeployment.spec.template.metadata.labels,
    },
});

// Export the frontend IP.
export let frontendIp: pulumi.Output<string>;
if (isMinikube) {
    frontendIp = frontendService.spec.clusterIP;
} else {
    frontendIp = frontendService.status.loadBalancer.ingress[0].apply(
        ingress => ingress.ip || ingress.hostname
    );
}

// Monitoring
const monitoringNs = new k8s.core.v1.Namespace("monitoring", {
    metadata: { name: "monitoring" },
});

const promStack = new k8s.helm.v3.Release("kube-prometheus-stack", {
    name: "kube-prometheus-stack",
    namespace: monitoringNs.metadata.name,
    chart: "kube-prometheus-stack",
    repositoryOpts: {
        repo: "https://prometheus-community.github.io/helm-charts",
    },
    values: {
        alertmanager: { enabled: false },
        grafana: {
            enabled: true,
            adminUser: grafanaAdminUser,
            adminPassword: grafanaAdminPassword,
            sidecar: {
                dashboards: {
                    enabled: true,
                    label: "grafana_dashboard",
                    labelValue: "1",
                    searchNamespace: "ALL",
                },
            },
        },
        prometheus: {
            prometheusSpec: {
                serviceMonitorSelectorNilUsesHelmValues: false,
                podMonitorSelectorNilUsesHelmValues: false,
                scrapeInterval: "15s",
            },
        },
    },
});

const guestbookServiceMonitor = new k8s.apiextensions.CustomResource(
    "guestbook-servicemonitor",
    {
        apiVersion: "monitoring.coreos.com/v1",
        kind: "ServiceMonitor",
        metadata: {
            name: "guestbook-monitor",
            namespace: monitoringNs.metadata.name,
        },
        spec: {
            namespaceSelector: {
                matchNames: ["default"],
            },
            selector: {
                matchExpressions: [
                    {
                        key: "app",
                        operator: "In",
                        values: ["frontend", "redis-leader", "redis-replica"],
                    },
                ],
            },
            endpoints: [
                {
                    port: "metrics",
                    interval: "15s",
                    path: "/metrics",
                },
            ],
        },
    },
    { dependsOn: [promStack] }
);

// Expose Grafana via a Pulumi-managed NodePort (Minikube) or LoadBalancer (Cloud) Service
const grafanaService = new k8s.core.v1.Service(
    "grafana-service",
    {
        metadata: {
            name: "grafana-external",
            namespace: monitoringNs.metadata.name,
        },
        spec: {
            type: isMinikube ? "NodePort" : "LoadBalancer",
            ports: [
                {
                    name: "http",
                    port: 80,
                    targetPort: 3000,
                    nodePort: isMinikube ? 30081 : undefined,
                },
            ],
            // Route traffic to the Grafana Pod created by kube-prometheus-stack
            selector: {
                "app.kubernetes.io/name": "grafana",
                "app.kubernetes.io/instance": "kube-prometheus-stack",
            },
        },
    },
    { dependsOn: [promStack] }
);

// Export Grafana Access URL and Admin Credentials
export const grafanaUrl = isMinikube
    ? pulumi.output("http://localhost:3000")
    : grafanaService.status.loadBalancer.ingress[0].apply(
          ingress => `http://${ingress.ip || ingress.hostname}`
      );
export const grafanaNodePort = isMinikube
    ? grafanaService.spec.ports[0].nodePort
    : undefined;
export const grafanaAdminUsername = grafanaAdminUser;
export const grafanaAdminPass = grafanaAdminPassword;

// Stretch Goal: Provision a Guestbook Grafana Dashboard automatically via ConfigMap
// Dashboard JSON is loaded from ./dashboards/guestbook-dashboard.json
const guestbookDashboard = new k8s.core.v1.ConfigMap(
    "guestbook-grafana-dashboard",
    {
        metadata: {
            name: "guestbook-grafana-dashboard",
            namespace: monitoringNs.metadata.name,
            labels: {
                grafana_dashboard: "1", // Tell Grafana's sidecar to auto-import this dashboard
            },
        },
        data: {
            "guestbook-dashboard.json": fs.readFileSync(
                path.join(__dirname, "dashboards", "guestbook-dashboard.json"),
                "utf8"
            ),
        },
    },
    { dependsOn: [promStack] }
);