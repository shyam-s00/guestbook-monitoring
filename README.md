# Kubernetes Guestbook with Prometheus & Grafana Monitoring

This project extends the [Pulumi Kubernetes Guestbook (TypeScript)](https://github.com/pulumi/examples/tree/master/kubernetes-ts-guestbook/simple) application by integrating end-to-end observability using **Prometheus** and **Grafana**.

---

## Architecture Overview

The Pulumi program ([`index.ts`](./index.ts)) deploys two layers into your Kubernetes cluster:

1. **Guestbook Application (`default` namespace)**
   * **`frontend` (3 replicas)**: PHP/Apache Guestbook web UI (`port 80`) paired with an **`apache-exporter` sidecar** (`port 9117`) exposing Apache HTTP request and worker metrics at `/metrics`.
   * **`redis-leader` (1 replica)**: Primary Redis database for writes (`port 6379`) paired with a **`redis-exporter` sidecar** (`port 9121`) exposing Redis metrics at `/metrics`.
   * **`redis-replica` (1 replica)**: Read-replica Redis instance (`port 6379`) paired with a **`redis-exporter` sidecar** (`port 9121`) exposing replication and read metrics at `/metrics`.

2. **Monitoring Stack (`monitoring` namespace)**
   * **`kube-prometheus-stack` (Helm Release)**: Deploys the Prometheus Operator, Prometheus Server, Grafana, `kube-state-metrics`, and `node-exporter`.
   * **`guestbook-monitor` (`ServiceMonitor`)**: Configures Prometheus to automatically discover and scrape the `metrics` port across the `frontend`, `redis-leader`, and `redis-replica` Services every `15s`.
   * **`grafana-external` (`Service`)**: Exposes Grafana via `NodePort` (`30081`) on local clusters (`isMinikube: true`) or `LoadBalancer` on cloud clusters (`isMinikube: false`).
   * **`guestbook-grafana-dashboard` (`ConfigMap`)**: Automatically provisions the **Guestbook Application Monitoring** dashboard ([`dashboards/guestbook-dashboard.json`](./dashboards/guestbook-dashboard.json)) into Grafana on startup via the Grafana dashboard sidecar.

---

## Prerequisites

1. [Node.js](https://nodejs.org/) (v18+) and `npm`
2. [Pulumi CLI](https://www.pulumi.com/docs/install/)
3. [`kubectl`](https://kubernetes.io/docs/tasks/tools/) configured to talk to a Kubernetes cluster:
   * **Local**: [Minikube](https://minikube.sigs.k8s.io/docs/start/) (`minikube start --cpus=2 --memory=4096`), Kind, or Docker Desktop Kubernetes
   * **Cloud**: AWS EKS, GCP GKE, or Azure AKS

---

## Deploying the Application

1. **Install Node.js dependencies:**
   ```bash
   npm install
   ```

2. **Initialize (or select) the Pulumi stack:**
   * If using local state without a Pulumi Cloud account, first run `pulumi login --local`.
   ```bash
   pulumi stack init dev
   ```

3. **Configure the target environment (`isMinikube`):**
   * **For Local Clusters (Minikube / Kind / Docker Desktop):** Uses `ClusterIP` / `NodePort` so deployment does not wait indefinitely for a cloud LoadBalancer IP:
     ```bash
     pulumi config set isMinikube true
     ```
   * **For Cloud Clusters (EKS / GKE / AKS):** Provisions external `LoadBalancer` services:
     ```bash
     pulumi config set isMinikube false
     ```
   * *(Optional)* Customize Grafana admin credentials (defaults to `admin` / `prom-operator`):
     ```bash
     pulumi config set grafanaAdminUser admin
     pulumi config set --secret grafanaAdminPassword <your-custom-password>
     ```

4. **Deploy the stack:**
   ```bash
   pulumi up
   ```

5. **View Pulumi Stack Outputs:**
   ```bash
   pulumi stack output
   ```
   Example output:
   ```text
   Current stack outputs (5):
     OUTPUT                VALUE
     frontendIp            10.104.21.85
     grafanaAdminPass      [secret]
     grafanaAdminUsername  admin
     grafanaNodePort       30081
     grafanaUrl            http://localhost:3000
   ```
   To reveal the masked Grafana admin password from the Pulumi stack output:
   ```bash
   pulumi stack output grafanaAdminPass --show-secrets
   ```

---

## Accessing the Guestbook & Grafana (Port-Forwarding Instructions)

### 1. Accessing the Guestbook Web UI

* **On Local Clusters (`isMinikube: true`) — Port-Forward Required:**
  Forward local port `8080` to the `frontend` service:
  ```bash
  kubectl port-forward svc/frontend 8080:80
  ```
  Open **[http://localhost:8080](http://localhost:8080)** in your browser and submit a few messages to generate live traffic.

* **On Cloud Clusters (`isMinikube: false`):**
  ```bash
  open "http://$(pulumi stack output frontendIp)"
  ```

---

### 2. Grafana Access URL & Default Admin Credentials

| Setting | Default Value | CLI Command to Retrieve |
|---|---|---|
| **Access URL (Local Port-Forward)** | `http://localhost:3000` | `pulumi stack output grafanaUrl` |
| **NodePort (Local Minikube)** | `30081` | `pulumi stack output grafanaNodePort` |
| **Admin Username** | `admin` | `pulumi stack output grafanaAdminUsername` |
| **Admin Password** | `prom-operator` | `pulumi stack output grafanaAdminPass --show-secrets` |

#### How to Connect to Grafana Locally (`isMinikube: true`):
* **Option A — Using `kubectl port-forward` (Recommended, works on all local clusters):**
  ```bash
  kubectl port-forward -n monitoring svc/grafana-external 3000:80
  ```
  Then open **[http://localhost:3000](http://localhost:3000)** and log in with `admin` / `prom-operator`.

* **Option B — Using Minikube's `NodePort` (`30081`) tunnel:**
  ```bash
  minikube service -n monitoring grafana-external
  ```

* **On Cloud Clusters (`isMinikube: false`):**
  Grafana is exposed directly via a Cloud `LoadBalancer`:
  ```bash
  open "$(pulumi stack output grafanaUrl)"
  ```

#### Viewing the Pre-Configured Guestbook Dashboard:
1. After logging into Grafana, navigate to **Dashboards** in the left sidebar.
2. Open **"Guestbook Application Monitoring"** (automatically loaded from [`dashboards/guestbook-dashboard.json`](./dashboards/guestbook-dashboard.json)).
3. The dashboard is organized into **3 collapsible service rows**:
   * **Frontend Service (Apache / PHP Web Tier):** Up pods, pod count history (desired vs. available vs. scraped), HTTP request rate (RPS), error rate & restarts, average request latency, open connections / worker states, pod CPU & memory usage.
   * **Redis Leader Service (Primary / Write Database):** Leader status, connected clients, connected replicas, total keys (`db0`), pod count history, command throughput (ops/sec), rejected connections, pod CPU, and container vs. Redis engine memory usage.
   * **Redis Replica Service (Read Replicas & Replication):** Replica status, master sync link status, open connections, replicated keys, read command rate, keyspace cache hits vs. misses, pod CPU, and memory usage.

---

## How to Verify Guestbook Metrics Are Being Scraped by Prometheus

### Step 1: Port-Forward the Prometheus Server
Run the following command to expose the Prometheus UI locally on port `9090`:
```bash
kubectl port-forward -n monitoring svc/kube-prometheus-stack-prometheus 9090:9090
```

### Step 2: Check Scrape Targets (`Status -> Targets`)
1. Open **[http://localhost:9090/targets](http://localhost:9090/targets)** in your browser.
2. Filter by `guestbook`.
3. Verify that **`serviceMonitor/monitoring/guestbook-monitor/0`** shows **`5/5 up`**:
   * 3 `frontend` pod endpoints (`:9117/metrics`)
   * 1 `redis-leader` pod endpoint (`:9121/metrics`)
   * 1 `redis-replica` pod endpoint (`:9121/metrics`)

### Step 3: Run Verification PromQL Queries (`Graph`)
Open **[http://localhost:9090/graph](http://localhost:9090/graph)** (or query via `curl`) and execute any of the following queries:

* **Verify Frontend Apache Exporter is up and scraping HTTP requests:**
  ```promql
  apache_up{service="frontend"}
  ```
  ```promql
  rate(apache_accesses_total{service="frontend"}[1m])
  ```
* **Verify Redis Leader & Replica Exporters are up and scraping Redis metrics:**
  ```promql
  redis_up
  ```
  ```promql
  sum by (service) (rate(redis_commands_processed_total[1m]))
  ```
  ```promql
  redis_connected_clients
  ```
* **Verify Guestbook Pod CPU & Memory resource metrics:**
  ```promql
  sum by (pod) (rate(container_cpu_usage_seconds_total{namespace="default", container!=""}[1m]))
  ```
  ```promql
  sum by (pod) (container_memory_working_set_bytes{namespace="default", container!=""}) / 1024 / 1024
  ```

### Step 4 (Optional): Inspect Raw `/metrics` Endpoints via Terminal
You can also inspect the raw Prometheus text metrics exposed by the sidecar containers directly:
```bash
# Inspect raw Frontend metrics (:9117)
kubectl port-forward svc/frontend 9117:9117 &
curl -s http://localhost:9117/metrics | grep -E "^apache_(up|accesses_total|workers)"

# Inspect raw Redis Leader metrics (:9121)
kubectl port-forward svc/redis-leader 9121:9121 &
curl -s http://localhost:9121/metrics | grep -E "^redis_(up|connected_clients|commands_processed_total|db_keys)"
```

---

## Cleaning Up

To tear down all Kubernetes resources created by Pulumi:
```bash
pulumi destroy
pulumi stack rm dev
```
