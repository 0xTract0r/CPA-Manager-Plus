package cpa

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type UsageConfig struct {
	UsageStatisticsEnabled          bool `json:"usageStatisticsEnabled"`
	RedisUsageQueueRetentionSeconds int  `json:"redisUsageQueueRetentionSeconds"`
	RetentionSourceDefault          bool `json:"retentionSourceDefault"`
}

type ManagementConfig struct {
	UsageConfig
	ProxyURL string `json:"proxyUrl,omitempty"`
}

func ValidateManagementAPI(ctx context.Context, baseURL string, key string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, NormalizeBaseURL(baseURL)+"/v0/management/config", nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+key)
	client := &http.Client{Timeout: 30 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode >= 200 && res.StatusCode < 300 {
		return nil
	}
	return errors.New("management API validation failed: " + res.Status)
}

func FetchUsageConfig(ctx context.Context, baseURL string, key string) (UsageConfig, error) {
	cfg, err := FetchManagementConfig(ctx, baseURL, key)
	if err != nil {
		return UsageConfig{}, err
	}
	return cfg.UsageConfig, nil
}

func FetchManagementConfig(ctx context.Context, baseURL string, key string) (ManagementConfig, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, NormalizeBaseURL(baseURL)+"/v0/management/config", nil)
	if err != nil {
		return ManagementConfig{}, err
	}
	req.Header.Set("Authorization", "Bearer "+key)
	client := &http.Client{Timeout: 30 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		return ManagementConfig{}, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return ManagementConfig{}, errors.New("management API config request failed: " + res.Status)
	}

	var raw map[string]any
	if err := json.NewDecoder(res.Body).Decode(&raw); err != nil {
		return ManagementConfig{}, err
	}
	usageEnabled := readBoolField(raw, "usage-statistics-enabled", "usageStatisticsEnabled")
	retention, hasRetention := readIntField(raw, "redis-usage-queue-retention-seconds", "redisUsageQueueRetentionSeconds")
	if !hasRetention {
		retention = 60
	}
	return ManagementConfig{
		UsageConfig: UsageConfig{
			UsageStatisticsEnabled:          usageEnabled,
			RedisUsageQueueRetentionSeconds: retention,
			RetentionSourceDefault:          !hasRetention,
		},
		ProxyURL: readStringField(raw, "proxy-url", "proxyUrl", "proxy_url"),
	}, nil
}

func SetUsageStatisticsEnabled(ctx context.Context, baseURL string, key string, enabled bool) error {
	payload := map[string]bool{"value": enabled}
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodPut,
		NormalizeBaseURL(baseURL)+"/v0/management/usage-statistics-enabled",
		strings.NewReader(string(data)),
	)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 30 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode >= 200 && res.StatusCode < 300 {
		return nil
	}
	return errors.New("enable CPA usage statistics failed: " + res.Status)
}

// UsageExportPageOptions windows a /v0/management/usage/export request to a
// single page of request details, mirroring core's `since`/`limit` query
// parameters (see core internal/api/handlers/management/usage.go). Since is
// accepted as-is (RFC3339 or unix milliseconds, whatever core expects); a
// zero-value/empty Since means "from the beginning", matching core's
// unwindowed default when no query params are sent at all.
type UsageExportPageOptions struct {
	// Since is the pagination cursor from a previous page's NextSince, or
	// empty for the first page.
	Since string
	// Limit is the maximum number of request details per model to return in
	// this page. 0 leaves it unset, which core treats as unlimited (full,
	// unwindowed export).
	Limit int
}

// UsageExportPage is the parsed pagination envelope from a windowed
// /v0/management/usage/export response. Body is the raw response bytes,
// still shaped like {"version":N,"exported_at":"...","usage":{...}} plus the
// optional has_more/next_since cursor fields, so it can be fed unchanged into
// the manager-server's own usage import parser (ImportFormatLegacyExport).
type UsageExportPage struct {
	Body      []byte
	HasMore   bool
	NextSince string
}

// FetchUsageExport fetches the full (unwindowed) legacy usage statistics
// export snapshot from a CPA core instance (GET /v0/management/usage/export,
// no since/limit) and returns the raw response body. Kept for callers that
// still want a single full-history pull; new incremental sync code should
// use FetchUsageExportPage instead.
func FetchUsageExport(ctx context.Context, baseURL string, key string) ([]byte, error) {
	page, err := FetchUsageExportPage(ctx, baseURL, key, UsageExportPageOptions{})
	if err != nil {
		return nil, err
	}
	return page.Body, nil
}

// FetchUsageExportPage fetches a single page of the usage statistics export
// from a CPA core instance (GET /v0/management/usage/export), optionally
// windowed by since/limit, and returns the raw response body alongside the
// has_more/next_since pagination cursors. Passing a zero-value
// UsageExportPageOptions (no Since, no Limit) reproduces the original
// unwindowed full-export behavior.
func FetchUsageExportPage(ctx context.Context, baseURL string, key string, options UsageExportPageOptions) (UsageExportPage, error) {
	endpoint := NormalizeBaseURL(baseURL) + "/v0/management/usage/export"
	query := make([]string, 0, 2)
	if since := strings.TrimSpace(options.Since); since != "" {
		query = append(query, "since="+url.QueryEscape(since))
	}
	if options.Limit > 0 {
		query = append(query, "limit="+strconv.Itoa(options.Limit))
	}
	if len(query) > 0 {
		endpoint += "?" + strings.Join(query, "&")
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return UsageExportPage{}, err
	}
	req.Header.Set("Authorization", "Bearer "+key)
	client := &http.Client{Timeout: 60 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		return UsageExportPage{}, err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(res.Body)
	if err != nil {
		return UsageExportPage{}, err
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return UsageExportPage{}, fmt.Errorf("core usage export request failed: %s", res.Status)
	}

	var pagination struct {
		HasMore   bool   `json:"has_more"`
		NextSince string `json:"next_since"`
	}
	// Pagination cursors are optional/backward compatible: older core
	// versions (or a full unwindowed export) simply omit them, in which case
	// json.Unmarshal leaves the zero values (HasMore=false, NextSince="").
	if err := json.Unmarshal(data, &pagination); err != nil {
		return UsageExportPage{}, fmt.Errorf("decode core usage export response: %w", err)
	}
	return UsageExportPage{
		Body:      data,
		HasMore:   pagination.HasMore,
		NextSince: pagination.NextSince,
	}, nil
}

func ValidateCollectorConfig(ctx context.Context, baseURL string, key string, pollIntervalMS int) error {
	usageCfg, err := FetchUsageConfig(ctx, baseURL, key)
	if err != nil {
		return err
	}
	retentionMS := usageCfg.RedisUsageQueueRetentionSeconds * 1000
	if retentionMS <= 0 {
		return errors.New("CPA redis-usage-queue-retention-seconds must be greater than 0")
	}
	if pollIntervalMS > retentionMS {
		return fmt.Errorf(
			"pollIntervalMs must be less than or equal to CPA redis-usage-queue-retention-seconds (%d seconds)",
			usageCfg.RedisUsageQueueRetentionSeconds,
		)
	}
	return nil
}

func NormalizeBaseURL(raw string) string {
	value := strings.TrimSpace(raw)
	if value == "" {
		return ""
	}
	if !strings.Contains(value, "://") {
		value = "http://" + value
	}
	value = strings.TrimRight(value, "/")
	value = strings.TrimSuffix(value, "/v0/management")
	value = strings.TrimSuffix(value, "/v0")
	return value
}

func readBoolField(raw map[string]any, keys ...string) bool {
	for _, key := range keys {
		value, ok := raw[key]
		if !ok {
			continue
		}
		switch typed := value.(type) {
		case bool:
			return typed
		case string:
			normalized := strings.ToLower(strings.TrimSpace(typed))
			return normalized == "1" || normalized == "true" || normalized == "yes" || normalized == "on"
		}
	}
	return false
}

func readIntField(raw map[string]any, keys ...string) (int, bool) {
	for _, key := range keys {
		value, ok := raw[key]
		if !ok || value == nil {
			continue
		}
		switch typed := value.(type) {
		case float64:
			return int(typed), true
		case int:
			return typed, true
		case json.Number:
			parsed, err := strconv.Atoi(typed.String())
			return parsed, err == nil
		case string:
			parsed, err := strconv.Atoi(strings.TrimSpace(typed))
			return parsed, err == nil
		}
	}
	return 0, false
}

func readStringField(raw map[string]any, keys ...string) string {
	for _, key := range keys {
		value, ok := raw[key]
		if !ok || value == nil {
			continue
		}
		return strings.TrimSpace(fmt.Sprint(value))
	}
	return ""
}
