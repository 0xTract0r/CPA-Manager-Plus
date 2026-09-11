# Usage Analytics

## Model Performance

The Model performance tab aggregates the full filtered event range: latency and first-response percentiles, overall output TPS, account costs, throughput, and sample coverage. Select a model to filter it, or View requests to inspect its trace. Thresholds are browser-local, on-page alerts; no external notifications are sent.

No setup is required: reference defaults are 60 seconds for most requests, 10 token/s for slower output, and 30 valid samples before evaluation. Edit the optional alert section and Apply, or Restore defaults. These controls do not change model speed or request timeouts.

The main view uses plain-language labels: typical is the middle value, most durations cover about 95% of requests, and about 10% of requests are slower than the slower-speed value. Detailed percentiles are expandable. Account rows show email/name and note from matching current credentials; missing identities are explicitly indicated and internal identifiers are tucked into an expandable section.

When an old ID no longer matches a current credential, a recorded historical email is shown with a source label. A current note is reused only for a unique email/provider match; missing historical notes are not inferred, and current identities take precedence.

Overall TPS is output tokens / executor attempt duration for successful valid events; means average event speeds. First response is the first upstream body byte, not necessarily text. Executor timing is not client end-to-end timing, and content chunks are not tokens.

Trace lookup covers the selected event plus/minus 24 hours and at most 100 events, combining records with the same attempt ID. Reporter-internal retries may remain unobserved. Concurrency is reconstructed only from completed telemetry intervals, not live queues. Historical missing stages cannot be recovered. Exact percentile queries reject more than 100000 matched events; narrow the filters rather than silently sampling. Cost remains an estimate, and these metrics do not assess answer quality.

Usage Analytics answers "where did the money go?" and "which requests caused the abnormal pattern?" It uses request-monitoring events and [Model Prices](./model-prices.md). It does not change provider billing.

## Pick The Range First

Start with time range and granularity:

- Today or the last hour is best for a recent incident.
- 7 days or 30 days is better for trend review.
- Custom range is useful for billing periods or incident windows.
- Finer granularity helps find spikes. Coarser granularity helps read trends.

Filters include model, API key, provider, status, auth file, latency, and cache state. Once filters are applied, trend charts, rankings, and preview rows all use the same request set.

## Main Views

- **Overview**: request count, tokens, cost, failure rate, and latency.
- **Model ranking**: the most expensive, most active, or least healthy models.
- **API Key ranking**: callers responsible for cost or failures.
- **Credential ranking**: account-level usage, useful with quota and inspection.
- **Trend charts**: request volume, cost, tokens, and failure rate over time.
- **Anomaly points**: sudden changes in cost, tokens, or failures.
- **Heatmap**: peak and quiet hours for scheduling decisions.
- **Request preview**: jump back to Monitoring for individual requests.

## Cost Spike Workflow

1. Check whether only cost increased, or whether request count and failure rate also increased.
2. Open model ranking to find expensive model concentration.
3. Open API Key ranking to find unusual callers.
4. Open credential ranking to find account or project concentration.
5. Jump to request details and confirm model names, tokens, and caller.

If the model name is an alias or internal name, add the matching entry in [Model Prices](./model-prices.md), or cost will be underestimated or empty.

## Accuracy Boundary

- Provider bills are the source of truth.
- CPAMP estimates cost from request events and model prices.
- If model names are rewritten by clients, providers, or route aliases, maintain the corresponding name in Model Prices.
- Missing token fields can make cost incomplete.
- Requests lost while Manager Server was stopped or queue data expired cannot be reconstructed.

Model tables support name search and alert-status filters. Account tables search email, note, name or ID and filter providers. Click headers for ascending/descending sorting; missing values stay last. Reset table clears local filters and restores event-count descending order. Table filters do not change summary cards or trends. TPS is end-to-end output tokens per second, including waiting time; short outputs can have low TPS without slow generation.
