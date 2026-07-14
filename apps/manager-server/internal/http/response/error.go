package response

import (
	"context"
	"errors"
	"net/http"
	"strings"
)

// clientClosedRequestStatus mirrors the widely used (nginx-originated) 499
// "Client Closed Request" convention. net/http has no named constant for it.
const clientClosedRequestStatus = 499

// ContextErrorStatus maps a context cancellation/deadline error to the HTTP
// status that actually describes what happened, instead of the generic 500
// a naive `err != nil -> 500` mapping would produce. This matters for slow,
// read-heavy endpoints (e.g. wide-time-range analytics aggregation) where a
// client or reverse proxy timing out and disconnecting mid-query is an
// expected, non-crashing outcome: canceling the request context here is not
// a server bug, and logging/alerting on it as a 500 misleads on-call
// debugging. Returns 0 if err is not a context cancellation/deadline error,
// signaling the caller should fall back to its own status mapping.
func ContextErrorStatus(err error) int {
	switch {
	case errors.Is(err, context.Canceled):
		// The caller (client or an intermediate proxy) gave up and closed the
		// connection before the query finished; nothing to write back to it.
		return clientClosedRequestStatus
	case errors.Is(err, context.DeadlineExceeded):
		return http.StatusGatewayTimeout
	default:
		return 0
	}
}

func Error(w http.ResponseWriter, status int, err error) {
	JSON(w, status, map[string]any{"error": err.Error(), "code": UsageServiceErrorCode(err)})
}

func MethodNotAllowed(w http.ResponseWriter) {
	Error(w, http.StatusMethodNotAllowed, errors.New("method not allowed"))
}

func SetupErrorStatus(err error) int {
	message := err.Error()
	switch {
	case strings.Contains(message, "setup is managed by environment variables"):
		return http.StatusConflict
	case strings.Contains(message, "invalid management key for existing setup"):
		return http.StatusUnauthorized
	case strings.Contains(message, "cpaBaseUrl and managementKey are required"),
		strings.Contains(message, "CPA redis-usage-queue-retention-seconds"),
		strings.Contains(message, "pollIntervalMs must be less than or equal"),
		strings.Contains(message, "invalid time zone"):
		return http.StatusBadRequest
	case strings.Contains(message, "management API validation failed"),
		strings.Contains(message, "enable CPA usage statistics failed"):
		return http.StatusBadGateway
	default:
		return http.StatusBadGateway
	}
}

func ManagerConfigErrorStatus(err error) int {
	message := err.Error()
	switch {
	case strings.Contains(message, "connection setup is managed by environment variables"),
		strings.Contains(message, "locked by environment variable"):
		return http.StatusConflict
	case strings.Contains(message, "CPA connection is already bound"):
		return http.StatusConflict
	case strings.Contains(message, "cpaBaseUrl and managementKey are required"),
		strings.Contains(message, "CPA redis-usage-queue-retention-seconds"),
		strings.Contains(message, "pollIntervalMs must be less than or equal"),
		strings.Contains(message, "invalid time zone"):
		return http.StatusBadRequest
	case strings.Contains(message, "management API validation failed"),
		strings.Contains(message, "management API config request failed"),
		strings.Contains(message, "enable CPA usage statistics failed"):
		return http.StatusBadGateway
	default:
		return http.StatusInternalServerError
	}
}

func ModelPriceErrorStatus(err error) int {
	if strings.Contains(err.Error(), "model price sync failed") {
		return http.StatusBadGateway
	}
	return http.StatusInternalServerError
}

// UsageSyncErrorStatus maps errors from UsageService.SyncFromCore to an HTTP
// status code for the /v0/management/usage/sync endpoint.
func UsageSyncErrorStatus(err error) int {
	message := err.Error()
	switch {
	case strings.Contains(message, "CPA core connection is not configured"):
		return http.StatusPreconditionFailed
	case strings.Contains(message, "fetch core usage export"):
		return http.StatusBadGateway
	default:
		return http.StatusInternalServerError
	}
}

func UsageServiceErrorCode(err error) string {
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return "request_timeout"
	case errors.Is(err, context.Canceled):
		return "request_canceled"
	}
	message := err.Error()
	switch {
	case strings.Contains(message, "connection setup is managed by environment variables"):
		return "connection_env_managed"
	case strings.Contains(message, "locked by environment variable"):
		return "account_processing_policy_env_locked"
	case strings.Contains(message, "CPA connection is already bound"):
		return "cpa_connection_already_bound"
	case strings.Contains(message, "cpaBaseUrl and managementKey are required when request monitoring is enabled"):
		return "cpa_connection_required_for_monitoring"
	case strings.Contains(message, "cpaBaseUrl and managementKey are required"):
		return "cpa_connection_required"
	case strings.Contains(message, "setup is managed by environment variables"):
		return "setup_env_managed"
	case strings.Contains(message, "invalid management key for existing setup"):
		return "invalid_existing_management_key"
	case strings.Contains(message, "invalid admin key"):
		return "invalid_admin_key"
	case strings.Contains(message, "invalid management key"):
		return "invalid_management_key"
	case strings.Contains(message, "usage service is not configured"):
		return "usage_service_not_configured"
	case strings.Contains(message, "CPA core connection is not configured"):
		return "cpa_core_connection_not_configured"
	case strings.Contains(message, "fetch core usage export"):
		return "cpa_core_usage_export_failed"
	case strings.Contains(message, "CPA redis-usage-queue-retention-seconds must be greater than 0"):
		return "cpa_usage_retention_invalid"
	case strings.Contains(message, "pollIntervalMs must be less than or equal"):
		return "poll_interval_exceeds_retention"
	case strings.Contains(message, "invalid time zone"):
		return "invalid_time_zone"
	case strings.Contains(message, "management API validation failed"):
		return "management_api_validation_failed"
	case strings.Contains(message, "management API config request failed"):
		return "management_api_config_failed"
	case strings.Contains(message, "enable CPA usage statistics failed"):
		return "enable_cpa_usage_statistics_failed"
	case strings.Contains(message, "prices are required"):
		return "prices_required"
	case strings.Contains(message, "api key aliases are required"):
		return "api_key_aliases_required"
	case strings.Contains(message, "api key alias already exists"):
		return "api_key_alias_duplicate"
	case strings.Contains(message, "model price sync failed"):
		return "model_price_sync_failed"
	case strings.Contains(message, "method not allowed"):
		return "method_not_allowed"
	default:
		return "request_failed"
	}
}
